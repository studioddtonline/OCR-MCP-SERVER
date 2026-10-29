import { createTempDir, removeTempDir } from "../../test/support/temp-dir.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { OAuthStore } from "./oauth-store.js";

test("OAuth store registers clients, consumes PKCE codes once, and audience-binds access tokens", () => {
  const dir = createTempDir("oauth-store-test-");
  const store = new OAuthStore(join(dir, "oauth.sqlite"));
  try {
    const client = store.registerClient({ clientName: "test-client", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] });
    const verifier = "a".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const resource = "https://ddns.s13e.net/mcp";
    const code = store.createAuthorizationCode({ clientId: client.clientId, redirectUri: client.redirectUris[0]!, codeChallenge: challenge, scope: "ocr:read", resource });
    const tokens = store.exchangeAuthorizationCode({ code, clientId: client.clientId, redirectUri: client.redirectUris[0]!, codeVerifier: verifier });
    assert.equal(tokens.scope, "ocr:read");
    assert.equal(store.verifyAccessToken(tokens.accessToken, resource)?.clientId, client.clientId);
    assert.equal(store.verifyAccessToken(tokens.accessToken, "https://evil.example/mcp"), undefined);
    store.revokeGrant(client.clientId, resource);
    assert.equal(store.verifyAccessToken(tokens.accessToken, resource), undefined, "revoking the grant invalidates its access tokens");
    assert.throws(() => store.exchangeAuthorizationCode({ code, clientId: client.clientId, redirectUri: client.redirectUris[0]!, codeVerifier: verifier }), /invalid_grant/);
    store.revokeAccessToken(tokens.accessToken);
    assert.equal(store.verifyAccessToken(tokens.accessToken, resource), undefined);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});


test("legacy login session table is dropped and there is no session API any more", () => {
  const dir = createTempDir("oauth-legacy-test-");
  const path = join(dir, "oauth.sqlite");
  const first = new OAuthStore(path);
  first.db.exec("CREATE TABLE oauth_login_sessions (session_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT");
  first.close();
  const store = new OAuthStore(path);
  try {
    const row = store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'oauth_login_sessions'").get();
    assert.equal(row, undefined, "reusable login sessions must not exist");
    assert.equal("createLoginSession" in store, false);
  } finally {
    store.close();
    removeTempDir(dir);
  }
});

test("refresh token rotation retains issued access tokens and replay revokes the family", () => {
  const dir = createTempDir("oauth-refresh-test-");
  const store = new OAuthStore(join(dir, "oauth.sqlite"));
  try {
    const client = store.registerClient({ clientName: "refresh-test", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] });
    const verifier = "r".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const resource = "https://ddns.s13e.net/mcp";
    const code = store.createAuthorizationCode({ clientId: client.clientId, redirectUri: client.redirectUris[0]!, codeChallenge: challenge, scope: "ocr:read", resource });
    const first = store.exchangeAuthorizationCode({ code, clientId: client.clientId, redirectUri: client.redirectUris[0]!, codeVerifier: verifier });
    const second = store.refreshAccessToken({ refreshToken: first.refreshToken, clientId: client.clientId, resource });
    assert.ok(store.verifyAccessToken(first.accessToken, resource), "an issued access token remains valid until expiry or family revocation");
    assert.ok(store.verifyAccessToken(second.accessToken, resource));
    assert.throws(() => store.refreshAccessToken({ refreshToken: first.refreshToken, clientId: client.clientId, resource }), /invalid_grant/);
    assert.equal(store.verifyAccessToken(second.accessToken, resource), undefined, "replay must revoke the family");
  } finally {
    store.close();
    removeTempDir(dir);
  }
});
