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


/** Node HTTP transport and host/path/method routing; MCP composition and auth wiring live elsewhere. */
export function startHttpServer(config: HttpServerConfig, mcpHandler: McpHttpHandler, oauth?: OAuthOptions) {
  const authGateway = createHttpAuthGateway(config, oauth);
  const { authRequired, authGate, oauthHandler, protectedResourceMetadataUrl, advertisedScopes } = authGateway;
  const allowedHosts = new Set(config.server.allowedHosts.map((h) => h.toLowerCase()));

  const handler = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      // Host ヘッダ検証。"*" は任意の Host を許可。
      const rawHost = request.headers.get("host");
      let host = "";
      if (rawHost) {
        try { host = new URL(`http://${rawHost}`).hostname.toLowerCase(); } catch { host = ""; }
      }
      if (!host || (!allowedHosts.has("*") && !allowedHosts.has(host))) {
        return new Response("Invalid Host header", { status: 400 });
      }

      if (request.method === "POST") {
        try {
          const boundedRequest = await capRequestBody(request);
          if (!boundedRequest) {
            return new Response("Request body exceeds the 1 MiB limit", {
              status: 413,
              headers: { "content-type": "text/plain; charset=utf-8", "connection": "close" },
            });
          }
          request = boundedRequest;
        } catch {
          return new Response("Invalid request body", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
      }

      if (oauthHandler) {
        const oauthResponse = await oauthHandler.fetch(request);
        if (oauthResponse) return oauthResponse;
      }

      if (url.pathname !== config.server.mcpPath) {
        return new Response("Not found", { status: 404 });
      }
      if (authRequired && !authGate) {
        const reason = authGateway.unavailableReason();
        console.log("[oauth] MCP request rejected because authentication is unavailable:", reason);
        return new Response("Authentication service temporarily unavailable", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
        });
      }
      if (!["POST", "GET", "DELETE"].includes(request.method)) {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST, DELETE" } });
      }

      // 認証なしモード (auth.mode === "none" のときだけここに到達する。上の authRequired ガードを参照)
      if (!authGate) return mcpHandler.fetch(request);

      let auth: Awaited<ReturnType<typeof authGate>>;
      try {
        auth = await authGate(request);
      } catch (error) {
        console.log("[oauth] token verification failed due to a runtime error:", describeForLog(error));
        return new Response("Authentication service temporarily unavailable", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
        });
      }
      if (auth instanceof Response) {
        if (auth.status === 401) {
          const headers = new Headers(auth.headers);
          if (protectedResourceMetadataUrl) {
            headers.set("WWW-Authenticate", `Bearer resource_metadata="${protectedResourceMetadataUrl}", scope="${advertisedScopes.join(" ")}"`);
          }
          return new Response(auth.body, { status: auth.status, statusText: auth.statusText, headers });
        }
        return auth;
      }
      return mcpHandler.fetch(request, { authInfo: auth });
    },
  };

  const nodeHandler = toNodeHandler(handler);
  const server = createNodeServer((req, res) => {
    void nodeHandler(req, res);
  });
  server.listen(config.server.port, config.server.host);
  return server;
}
