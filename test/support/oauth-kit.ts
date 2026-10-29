import { createTempDir, removeTempDir } from "./temp-dir.js";
// テスト用の共通ヘルパー (本番コードからは使わない)。
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppConfig } from "../../src/config/types.js";
import { OAuthStore } from "../../src/auth/oauth-store.js";
import { TokenStore } from "../../src/auth/token-store.js";
import { createOAuthHandler } from "../../src/auth/oauth/index.js";

export const BASE = "https://ddns.s13e.net";
export const RESOURCE = `${BASE}/mcp`;
export const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
export const OTHER_CALLBACK = "https://grok.com/connectors-oauth-exchange-code";
export const CIMD_CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";

export const testConfig: AppConfig = {
  server: { host: "127.0.0.1", port: 0, publicBaseUrl: BASE, mcpPath: "/mcp", allowedHosts: ["ddns.s13e.net", "127.0.0.1"] },
  auth: { mode: "oauth" },
  database: { path: "/tmp/unused-ocr.sqlite", busyTimeoutMs: 5000 },
  oauth: {
    databasePath: "/tmp/unused-oauth.sqlite",
    allowedRedirectUris: [CALLBACK, OTHER_CALLBACK],
    cimdAllowedHosts: ["claude.ai"],
  },
  staticTokens: { databasePath: "/tmp/unused-tokens.sqlite" },
  search: { defaultLimit: 20, maxLimit: 50, snippetLength: 160 },
};

export function setupOAuth(options: { cimdDoc?: unknown; ocrWriteEnabled?: boolean } = {}) {
  const dir = createTempDir("oauth-test-");
  const store = new OAuthStore(join(dir, "oauth.sqlite"));
  const tokens = new TokenStore(join(dir, "tokens.sqlite"));
  const loginToken = tokens.create({ name: "owner", purpose: "login" }).token;
  const fetched: string[] = [];
  const fetchImpl = (async (input: URL | string) => {
    fetched.push(String(input));
    return new Response(JSON.stringify(options.cimdDoc ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const config: AppConfig = {
    ...testConfig,
    ocrWrite: { enabled: options.ocrWriteEnabled ?? false },
  };
  const handler = createOAuthHandler(config, store, tokens, { fetchImpl });
  return {
    dir, store, tokens, handler, fetched, loginToken,
    cleanup: () => { store.close(); tokens.close(); removeTempDir(dir); },
  };
}
export type OAuthSetup = ReturnType<typeof setupOAuth>;

export function pkcePair() {
  const verifier = "v".repeat(60);
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}): URL {
  const u = new URL(`${BASE}/authorize`);
  const params: Record<string, string> = {
    response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge,
    code_challenge_method: "S256", state: "state-123", resource: RESOURCE, ...extra,
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}

/** 同意画面のフォームが POST するのと同じ内容を送る。 */
export function postAuthorize(
  handler: OAuthSetup["handler"],
  fields: { clientId: string; challenge: string; loginToken?: string; decision?: string; scope?: string; grantScopes?: string[]; redirectUri?: string; origin?: string | null },
) {
  const body = new URLSearchParams({
    client_id: fields.clientId, redirect_uri: fields.redirectUri ?? CALLBACK, response_type: "code",
    code_challenge: fields.challenge, code_challenge_method: "S256", resource: RESOURCE,
    scope: fields.scope ?? "ocr:read", state: "state-123", decision: fields.decision ?? "approve",
  });
  if (fields.loginToken !== undefined) body.set("login_token", fields.loginToken);
  for (const s of fields.grantScopes ?? []) body.append("grant_scope", s);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (fields.origin !== null) headers.origin = fields.origin ?? BASE;
  return handler.fetch(new Request(`${BASE}/authorize`, { method: "POST", headers, body }));
}

export async function registerDcr(handler: OAuthSetup["handler"], name = "test client", redirectUri = CALLBACK): Promise<string> {
  const res = await handler.fetch(new Request(`${BASE}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri] }),
  }));
  if (res?.status !== 201) throw new Error(`DCR failed: ${res?.status}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

export function codeFrom(response: Response | undefined): string {
  const location = response?.headers.get("location");
  if (!location) throw new Error("no redirect location");
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`no code in ${location}`);
  return code;
}

export function exchangeCode(handler: OAuthSetup["handler"], clientId: string, code: string, verifier: string, extra: Record<string, string> = {}) {
  return handler.fetch(new Request(`${BASE}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: CALLBACK, code_verifier: verifier, ...extra }),
  }));
}

export function codeCount(setup: OAuthSetup): number {
  return Number((setup.store.db.prepare("SELECT COUNT(*) AS c FROM oauth_authorization_codes").get() as { c: number }).c);
}
