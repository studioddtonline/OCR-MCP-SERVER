import { createTempDir, removeTempDir } from "../../test/support/temp-dir.js";
import assert from "node:assert/strict";
import { request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { OcrRepository } from "../features/ocr/repository.js";
import { OAuthStore } from "../auth/oauth-store.js";
import { TokenStore } from "../auth/token-store.js";
import { RESOURCE, testConfig } from "../../test/support/oauth-kit.js";
import { createOcrFixtureDatabase } from "../../test/support/ocr-fixture.js";
import { closeTestServer, waitForTestServer } from "../../test/support/http-server.js";
import { startHttpServer, MAX_HTTP_REQUEST_BODY_BYTES } from "./server.js";
import { createMcpHttpHandler } from "../mcp/http-handler.js";
import { createTestMcpRuntime } from "../../test/support/mcp-runtime.js";

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

async function withServer(run: (ctx: { url: string; port: number; store: OAuthStore; tokens: TokenStore }) => Promise<void>) {
  const dir = createTempDir("server-test-");
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "020.webp", text: "sample OCR text", reviewed: 1 },
    { id: 2, label: "Book A", fileName: "021.webp", text: "another OCR text", reviewed: 0 }
  ]);
  const store = new OAuthStore(join(dir, "oauth.sqlite"));
  const tokens = new TokenStore(join(dir, "tokens.sqlite"));
  const server: Server = startHttpServer(testConfig, createMcpHttpHandler(createTestMcpRuntime(new OcrRepository(db)), testConfig), { status: "ready", store, tokens });
  const { port, base } = await waitForTestServer(server);
  try {
    await run({ url: `${base}/mcp`, port, store, tokens });
  } finally {
    await closeTestServer(server);
    store.close(); tokens.close(); db.close();
    removeTempDir(dir);
  }
}

const call = (url: string, bearer: string | undefined, body: unknown) =>
  fetch(url, { method: "POST", headers: { ...MCP_HEADERS, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
const statsCall = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_ocr_stats", arguments: {} } };

test("unauthenticated requests get 401 with the OAuth discovery challenge", async () => {
  await withServer(async ({ url }) => {
    const res = await call(url, undefined, statsCall);
    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /^Bearer /);
    assert.ok(challenge.includes('resource_metadata="https://ddns.s13e.net/.well-known/oauth-protected-resource/mcp"'));
    assert.ok(challenge.includes('scope="ocr:read"'));
  });
});

test("an api static token can call MCP tools; revoked, expired, login-purpose and garbage tokens cannot", async () => {
  await withServer(async ({ url, tokens }) => {
    const api = tokens.create({ name: "claude-code", purpose: "api" }).token;
    const ok = await call(url, api, statsCall);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /\\"total\\":\s*2/);

    const login = tokens.create({ name: "owner", purpose: "login" }).token;
    assert.equal((await call(url, login, statsCall)).status, 401, "login tokens must not work on MCP");
    assert.equal((await call(url, "ocrmcp_api_" + "x".repeat(43), statsCall)).status, 401);
    assert.equal((await call(url, "totally-not-a-token", statsCall)).status, 401);

    tokens.db.prepare("UPDATE static_tokens SET expires_at = ? WHERE name = 'claude-code'").run(Math.floor(Date.now() / 1000) - 1);
    assert.equal((await call(url, api, statsCall)).status, 401, "expired");
    const other = tokens.create({ name: "cursor", purpose: "api" }).token;
    assert.equal((await call(url, other, statsCall)).status, 200);
    tokens.revoke("cursor");
    assert.equal((await call(url, other, statsCall)).status, 401, "revoked");
  });
});

test("OAuth access tokens and static tokens work side by side", async () => {
  await withServer(async ({ url, store, tokens }) => {
    const { createHash } = await import("node:crypto");
    const verifier = "z".repeat(60);
    const client = store.registerClient({ clientName: "Claude", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] });
    const code = store.createAuthorizationCode({
      clientId: client.clientId, redirectUri: client.redirectUris[0]!, scope: "ocr:read", resource: RESOURCE,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    const oauth = store.exchangeAuthorizationCode({ code, clientId: client.clientId, redirectUri: client.redirectUris[0]!, codeVerifier: verifier });
    assert.equal((await call(url, oauth.accessToken, statsCall)).status, 200);
    assert.equal((await call(url, tokens.create({ name: "s", purpose: "api" }).token, statsCall)).status, 200);
    store.revokeAccessToken(oauth.accessToken);
    assert.equal((await call(url, oauth.accessToken, statsCall)).status, 401);
  });
});

test("Host header validation and removed routes", async () => {
  await withServer(async ({ port }) => {
    const status = (path: string, host: string, method = "GET") => new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(await status("/mcp", "evil.example"), 400);
    assert.equal(await status("/login", "ddns.s13e.net", "POST"), 404, "the cookie login route is gone");
    assert.equal(await status("/.well-known/oauth-authorization-server", "ddns.s13e.net"), 200);
    for (const [path, method] of [["/token", "GET"], ["/register", "GET"], ["/authorize", "DELETE"], ["/revoke", "GET"]] as const) {
      assert.equal(await status(path, "ddns.s13e.net", method), 404, `${method} ${path} must remain 404 during OAuth route refactoring`);
    }
    const mcpMethod = await new Promise<{ status: number; allow: string | undefined }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method: "PUT", headers: { host: "ddns.s13e.net" } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, allow: res.headers.allow });
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(mcpMethod.status, 405);
    assert.equal(mcpMethod.allow, "GET, POST, DELETE");

    const tooLarge = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST", headers: MCP_HEADERS, body: "x".repeat(MAX_HTTP_REQUEST_BODY_BYTES + 1),
    });
    assert.equal(tooLarge.status, 413, "the Node HTTP handler enforces the body cap even behind Caddy");
  });
});


test("OAuth database startup failure keeps HTTP service up and returns 503 for stateful requests", async () => {
  const dir = createTempDir("server-unavailable-test-");
  const db = createOcrFixtureDatabase(":memory:", []);
  const server: Server = startHttpServer(testConfig, createMcpHttpHandler(createTestMcpRuntime(new OcrRepository(db)), testConfig), { status: "unavailable", unavailableReason: "permission denied" });
  const { port, base } = await waitForTestServer(server);
  try {
    assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { host: "ddns.s13e.net" } })).status, 200);
    const mcp = await call(`${base}/mcp`, undefined, statsCall);
    assert.equal(mcp.status, 503, "MCP must not become unauthenticated when auth databases are unavailable");
    assert.equal(mcp.headers.get("retry-after"), "60", "temporary MCP authentication outages must provide Retry-After");
    const token = await fetch(`${base}/token`, { method: "POST", headers: { host: "ddns.s13e.net", "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token" });
    assert.equal(token.status, 503);
  } finally {
    await closeTestServer(server);
    db.close();
    removeTempDir(dir);
  }
});


// TODO: Decide separately whether runtime failures during token verification should become 503.
// This test intentionally records the currently observed behavior (HTTP 500) and does not
// change production code. `startHttpServer()` has a catch around `authGate(request)` that
// would return 503 with `Retry-After: 60` if the gate threw. However, in this scenario the
// MCP SDK's `requireBearerAuth()` path converts the verifier exception into an HTTP 500
// Response instead of rethrowing it. Therefore `authGate(request)` resolves to a Response,
// and the application-level catch is never entered.
// The separate startup-unavailable test covers a different path: the server sees that the
// authentication gateway is unavailable before invoking the gate, so it returns 503 and
// `Retry-After: 60` as expected. It does not cover an exception raised during live verification.
// Expecting 503 here would assert a contract the current implementation does not provide.
// If runtime verifier failures must later return 503, change the production SDK/gateway
// integration deliberately, then change this assertion to 503 and verify `Retry-After: 60`.
test("MCP token verification runtime errors currently return 500", async () => {
  const dir = createTempDir("server-token-verification-error-");
  const db = createOcrFixtureDatabase(":memory:", []);
  const store = new OAuthStore(join(dir, "oauth.sqlite"));
  const tokens = new TokenStore(join(dir, "tokens.sqlite"));
  const apiToken = tokens.create({ name: "runtime-error", purpose: "api" }).token;
  const server: Server = startHttpServer(testConfig, createMcpHttpHandler(createTestMcpRuntime(new OcrRepository(db)), testConfig), { status: "ready", store, tokens });
  const { base } = await waitForTestServer(server);
  let tokensClosed = false;
  try {
    // Force the real TokenStore verification path to throw as it would if its database became unavailable.
    tokens.close();
    tokensClosed = true;

    const res = await call(`${base}/mcp`, apiToken, statsCall);
    assert.equal(res.status, 500, "the SDK currently converts a verifier exception into an HTTP 500 response");
  } finally {
    await closeTestServer(server);
    store.close();
    if (!tokensClosed) tokens.close();
    db.close();
    removeTempDir(dir);
  }
});
