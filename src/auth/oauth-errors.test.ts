import assert from "node:assert/strict";
import { test } from "node:test";
import { OAuthGrantError, OAuthValidationError } from "./oauth-store.js";
import {
  BASE, CALLBACK, CIMD_CLIENT_ID, authorizeUrl, pkcePair, postAuthorize, registerDcr, setupOAuth, type OAuthSetup,
} from "../../test/support/oauth-kit.js";

// 「入力の誤り」(専用エラークラス) は 4xx、それ以外の想定外の例外 (DB 障害など) は 503。
// 以前は文字列 "invalid_grant" の一致で判定していたため、型で区別することで取り違えを防ぐ。

const postToken = (t: OAuthSetup, clientId: string) =>
  t.handler.fetch(new Request(`${BASE}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: "c", redirect_uri: CALLBACK, code_verifier: "v".repeat(60) }),
  }));
const postRegister = (t: OAuthSetup, body: unknown) =>
  t.handler.fetch(new Request(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const boom = () => { throw new Error("disk I/O error"); };

test("/token: OAuthGrantError is invalid_grant (400); any other exception is 503", async () => {
  const t = setupOAuth();
  try {
    const clientId = await registerDcr(t.handler);
    // 本物の「不明な認可コード」は invalid_grant
    const real = await postToken(t, clientId);
    assert.equal(real?.status, 400);
    assert.deepEqual(await real!.json(), { error: "invalid_grant" });

    Object.assign(t.store, { exchangeAuthorizationCode: () => { throw new OAuthGrantError(); } });
    assert.equal((await postToken(t, clientId))?.status, 400);

    // メッセージが偶然 "invalid_grant" でも、型が違えば 503 (文字列一致では誤分類していたケース)
    Object.assign(t.store, { exchangeAuthorizationCode: () => { throw new Error("invalid_grant"); } });
    assert.equal((await postToken(t, clientId))?.status, 503);

    Object.assign(t.store, { exchangeAuthorizationCode: boom });
    const failed = await postToken(t, clientId);
    assert.equal(failed?.status, 503);
    assert.deepEqual(await failed!.json(), { error: "temporarily_unavailable" });
  } finally { t.cleanup(); }
});

test("/register: validation problems are 400 with the matching OAuth error; DB failures are 503", async () => {
  const t = setupOAuth();
  try {
    const tooLong = await postRegister(t, { client_name: "x".repeat(201), redirect_uris: [CALLBACK] });
    assert.equal(tooLong?.status, 400);
    assert.deepEqual(await tooLong!.json(), { error: "invalid_client_metadata" });

    Object.assign(t.store, { registerClient: () => { throw new OAuthValidationError("bad uri", "invalid_redirect_uri"); } });
    const badUri = await postRegister(t, { client_name: "c", redirect_uris: [CALLBACK] });
    assert.equal(badUri?.status, 400);
    assert.deepEqual(await badUri!.json(), { error: "invalid_redirect_uri" });

    Object.assign(t.store, { registerClient: boom });
    assert.equal((await postRegister(t, { client_name: "c", redirect_uris: [CALLBACK] }))?.status, 503);
  } finally { t.cleanup(); }
});

test("POST /authorize: validation errors from the store show the error page (400); other failures are 503", async () => {
  const t = setupOAuth();
  try {
    const clientId = await registerDcr(t.handler);
    const { challenge } = pkcePair();
    Object.assign(t.store, { createAuthorizationCode: () => { throw new OAuthValidationError("Invalid PKCE code_challenge", "invalid_request"); } });
    const invalid = await postAuthorize(t.handler, { clientId, challenge, loginToken: t.loginToken });
    assert.equal(invalid?.status, 400);
    assert.match(await invalid!.text(), /拒否/);

    Object.assign(t.store, { createAuthorizationCode: boom });
    const failed = await postAuthorize(t.handler, { clientId, challenge, loginToken: t.loginToken });
    assert.equal(failed?.status, 503);
  } finally { t.cleanup(); }
});

test("CIMD client upsert: invalid metadata means an invalid client (400); a DB failure means 503", async () => {
  const doc = { client_id: CIMD_CLIENT_ID, client_name: "Claude", redirect_uris: [CALLBACK] };
  const t = setupOAuth({ cimdDoc: doc });
  try {
    const { challenge } = pkcePair();
    Object.assign(t.store, { upsertClient: () => { throw new OAuthValidationError("Invalid client_name", "invalid_client_metadata"); } });
    assert.equal((await t.handler.fetch(new Request(authorizeUrl(CIMD_CLIENT_ID, challenge))))?.status, 400);

    Object.assign(t.store, { upsertClient: boom });
    assert.equal((await t.handler.fetch(new Request(authorizeUrl(CIMD_CLIENT_ID, challenge))))?.status, 503);
  } finally { t.cleanup(); }
});

test("the real store throws OAuthValidationError for bad input and OAuthGrantError for bad grants", async () => {
  const t = setupOAuth();
  try {
    assert.throws(() => t.store.registerClient({ clientName: "", redirectUris: [CALLBACK] }), (e) => e instanceof OAuthValidationError && e.oauthError === "invalid_client_metadata");
    assert.throws(() => t.store.registerClient({ clientName: "ok", redirectUris: ["not a url"] }), (e) => e instanceof OAuthValidationError && e.oauthError === "invalid_redirect_uri");
    assert.throws(() => t.store.registerClient({ clientName: "ok", redirectUris: ["http://evil.example/cb"] }), (e) => e instanceof OAuthValidationError);
    const client = t.store.registerClient({ clientName: "ok", redirectUris: [CALLBACK] });
    assert.throws(() => t.store.exchangeAuthorizationCode({ code: "nope", clientId: client.clientId, redirectUri: CALLBACK, codeVerifier: "v".repeat(60) }), OAuthGrantError);
    assert.throws(() => t.store.refreshAccessToken({ refreshToken: "nope", clientId: client.clientId, resource: `${BASE}/mcp` }), OAuthGrantError);
    assert.throws(() => t.store.createAuthorizationCode({ clientId: "unknown", redirectUri: CALLBACK, codeChallenge: "c".repeat(43), scope: "ocr:read", resource: `${BASE}/mcp` }), OAuthValidationError);
  } finally { t.cleanup(); }
});
