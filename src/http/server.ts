import { createServer as createNodeServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { AppConfig } from "../config/types.js";
import type { OAuthOptions } from "../auth/options.js";
import { createHttpAuthGateway } from "../auth/http-gateway.js";
import type { McpHttpHandler } from "../mcp/http-handler.js";
import { describeForLog } from "../shared/errors.js";

export type HttpServerConfig = Pick<AppConfig, "server" | "auth" | "oauth" | "ocrWrite">;

/** Node-side cap is required because the deployed Caddy 2.6.2 does not provide request_body limits. */
export const MAX_HTTP_REQUEST_BODY_BYTES = 1024 * 1024;

async function capRequestBody(request: Request): Promise<Request | undefined> {
  if (request.method !== "POST" || !request.body) return request;
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > MAX_HTTP_REQUEST_BODY_BYTES) {
      void request.body?.cancel().catch(() => undefined);
      return undefined;
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value) continue;
      length += part.value.byteLength;
      if (length > MAX_HTTP_REQUEST_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
}

/** Applies the body cap to a POST. Returns the bounded request, or the 413/400 response to send instead. */
async function boundPostBody(request: Request): Promise<Request | Response> {
  if (request.method !== "POST") return request;
  try {
    const bounded = await capRequestBody(request);
    if (!bounded) {
      return new Response("Request body exceeds the 1 MiB limit", {
        status: 413,
        headers: { "content-type": "text/plain; charset=utf-8", "connection": "close" },
      });
    }
    return bounded;
  } catch {
    return new Response("Invalid request body", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8", "connection": "close" },
    });
  }
}

/** Prevent reuse of a connection when an early response leaves a request body unread. */
function closeIfBodyUnread(request: Request, response: Response): Response {
  if (!request.body) return response;
  const headers = new Headers(response.headers);
  headers.set("connection", "close");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Central gate for responses returned before the request body has been consumed. */
function rejectEarly(request: Request, response: Response): Response {
  return closeIfBodyUnread(request, response);
}

/** "*" allows any Host. */
function isAllowedHost(rawHost: string | null, allowedHosts: ReadonlySet<string>): boolean {
  let host = "";
  if (rawHost) {
    try { host = new URL(`http://${rawHost}`).hostname.toLowerCase(); } catch { host = ""; }
  }
  return host !== "" && (allowedHosts.has("*") || allowedHosts.has(host));
}

const MCP_METHODS: ReadonlySet<string> = new Set(["POST", "GET", "DELETE"]);
const TEXT_PLAIN = { "content-type": "text/plain; charset=utf-8" } as const;


/** Node HTTP transport and host/path/method routing; MCP composition and auth wiring live elsewhere. */
export function startHttpServer(config: HttpServerConfig, mcpHandler: McpHttpHandler, oauth?: OAuthOptions) {
  const authGateway = createHttpAuthGateway(config, oauth);
  const { authRequired, authGate, oauthHandler, protectedResourceMetadataUrl, advertisedScopes } = authGateway;
  const allowedHosts = new Set(config.server.allowedHosts.map((h) => h.toLowerCase()));

  type AuthResult = Awaited<ReturnType<NonNullable<typeof authGate>>>;

  /**
   * OAuth stage. Other POSTs are capped before OAuth routing, preserving the limit for OAuth endpoints
   * and future OAuth routes; MCP requests are bounded only after authentication.
   */
  async function routeOAuth(request: Request, isMcpPath: boolean): Promise<Response | undefined> {
    if (!oauthHandler) return undefined;
    let oauthRequest = request;
    if (request.method === "POST" && !isMcpPath) {
      const bounded = await boundPostBody(request);
      if (bounded instanceof Response) return bounded;
      oauthRequest = bounded;
    }
    return oauthHandler.fetch(oauthRequest);
  }

  /** Verifies the bearer token. Returns auth info, or the response to send instead. */
  async function authenticate(request: Request, gate: NonNullable<typeof authGate>): Promise<Exclude<AuthResult, Response> | Response> {
    let auth: AuthResult;
    try {
      auth = await gate(request);
    } catch (error) {
      console.log("[oauth] token verification failed due to a runtime error:", describeForLog(error));
      return rejectEarly(request, new Response("Authentication service temporarily unavailable", {
        status: 503, headers: { ...TEXT_PLAIN, "retry-after": "60" },
      }));
    }
    if (!(auth instanceof Response)) return auth;
    if (auth.status !== 401) return rejectEarly(request, auth);
    const headers = new Headers(auth.headers);
    if (protectedResourceMetadataUrl) {
      headers.set("WWW-Authenticate", `Bearer resource_metadata="${protectedResourceMetadataUrl}", scope="${advertisedScopes.join(" ")}"`);
    }
    return rejectEarly(request, new Response(auth.body, { status: auth.status, statusText: auth.statusText, headers }));
  }

  /** Bounds the body (POST only) and hands the request to the MCP handler after authorization. */
  async function forwardToMcp(request: Request, authInfo?: Exclude<AuthResult, Response>): Promise<Response> {
    const bounded = await boundPostBody(request);
    if (bounded instanceof Response) return bounded;
    return authInfo ? mcpHandler.fetch(bounded, { authInfo }) : mcpHandler.fetch(bounded);
  }

  async function handleMcp(request: Request): Promise<Response> {
    if (authRequired && !authGate) {
      console.log("[oauth] MCP request rejected because authentication is unavailable:", authGateway.unavailableReason());
      return rejectEarly(request, new Response("Authentication service temporarily unavailable", {
        status: 503, headers: { ...TEXT_PLAIN, "retry-after": "60" },
      }));
    }
    if (!MCP_METHODS.has(request.method)) {
      return rejectEarly(request, new Response("Method not allowed", {
        status: 405, headers: { Allow: "GET, POST, DELETE" },
      }));
    }
    // 認証なしモード (auth.mode === "none" のときだけここに到達する。上の authRequired ガードを参照)
    if (!authGate) return forwardToMcp(request);

    const auth = await authenticate(request, authGate);
    if (auth instanceof Response) return auth;
    return forwardToMcp(request, auth);
  }

  const handler = {
    async fetch(request: Request): Promise<Response> {
      if (!isAllowedHost(request.headers.get("host"), allowedHosts)) {
        return rejectEarly(request, new Response("Invalid Host header", { status: 400 }));
      }
      const isMcpPath = new URL(request.url).pathname === config.server.mcpPath;

      const oauthResponse = await routeOAuth(request, isMcpPath);
      if (oauthResponse) return oauthResponse;

      return isMcpPath ? handleMcp(request) : rejectEarly(request, new Response("Not found", { status: 404 }));
    },
  };

  const nodeHandler = toNodeHandler(handler);
  const server = createNodeServer((req, res) => {
    void nodeHandler(req, res);
  });
  server.listen(config.server.port, config.server.host);
  return server;
}
