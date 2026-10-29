import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE, CALLBACK, CIMD_CLIENT_ID, RESOURCE,
  authorizeUrl, codeFrom, exchangeCode, pkcePair, postAuthorize, setupOAuth,
} from "../../test/support/oauth-kit.js";

const goodDoc = {
  client_id: CIMD_CLIENT_ID, client_name: "Claude",
  redirect_uris: [CALLBACK, "http://localhost/callback"], token_endpoint_auth_method: "none",
};

test("metadata advertises CIMD + public client auth (both required for Claude to pick CIMD) and keeps DCR", async () => {
  const t = setupOAuth();
  try {
    const res = await t.handler.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    const meta = (await res!.json()) as Record<string, unknown>;
    assert.equal(meta.client_id_metadata_document_supported, true);
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, ["none"]);
    assert.equal(meta.registration_endpoint, `${BASE}/register`);
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(meta.scopes_supported, ["ocr:read"], "write is not advertised while ocrWrite is disabled");
    const prm = (await (await t.handler.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`)))!.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(prm.resource, RESOURCE);
    assert.deepEqual(prm.authorization_servers, [BASE]);
  } finally { t.cleanup(); }
});

test("CIMD flow: consent with login token (CSP allows claude.ai redirect), token without resource param, refresh", async () => {
  const t = setupOAuth({ cimdDoc: goodDoc });
  try {
    const { verifier, challenge } = pkcePair();
    // scope に未知値 (offline_access) が付いても拒否しない
    const consent = await t.handler.fetch(new Request(authorizeUrl(CIMD_CLIENT_ID, challenge, { scope: "ocr:read offline_access" })));
    assert.equal(consent?.status, 200);
    assert.match(consent!.headers.get("content-security-policy")!, /form-action 'self' https:\/\/claude\.ai/);
    const body = await consent!.text();
    assert.match(body, /claude\.ai/);
    assert.match(body, /確認済み/);
    assert.ok(t.fetched.includes(CIMD_CLIENT_ID));

    const approval = await postAuthorize(t.handler, { clientId: CIMD_CLIENT_ID, challenge, loginToken: t.loginToken });
    assert.equal(approval?.status, 303);
    const callback = new URL(approval!.headers.get("location")!);
    assert.equal(callback.origin + callback.pathname, CALLBACK);
    assert.equal(callback.searchParams.get("iss"), BASE);

    // resource なしでもトークン発行できる
    const tokenRes = await exchangeCode(t.handler, CIMD_CLIENT_ID, codeFrom(approval), verifier);
    assert.equal(tokenRes?.status, 200);
    const tokens = (await tokenRes!.json()) as { access_token: string; refresh_token: string };
    assert.equal(t.store.verifyAccessToken(tokens.access_token, RESOURCE)?.clientId, CIMD_CLIENT_ID);

    const refresh = (token: string) => t.handler.fetch(new Request(`${BASE}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: CIMD_CLIENT_ID, refresh_token: token }),
    }));
    assert.equal((await refresh(tokens.refresh_token))?.status, 200);
    // ローテーション済みの旧 refresh token は使えない
    assert.equal((await refresh(tokens.refresh_token))?.status, 400);
  } finally { t.cleanup(); }
});

test("CIMD client metadata is upserted once when its validated contents do not change", async () => {
  const t = setupOAuth({ cimdDoc: goodDoc });
  const originalUpsert = t.store.upsertClient.bind(t.store);
  let upserts = 0;
  Object.assign(t.store, {
    upsertClient(input: Parameters<typeof t.store.upsertClient>[0]) {
      upserts += 1;
      return originalUpsert(input);
    },
  });
  try {
    const { challenge } = pkcePair();
    assert.equal((await t.handler.fetch(new Request(authorizeUrl(CIMD_CLIENT_ID, challenge))))?.status, 200);
    assert.equal((await t.handler.fetch(new Request(authorizeUrl(CIMD_CLIENT_ID, challenge))))?.status, 200);
    assert.equal(upserts, 1, "the second authorize request should read the existing client without writing it again");
  } finally { t.cleanup(); }
});

test("CIMD: wrong client_id in document, disallowed host, and disallowed redirect are all rejected", async () => {
  const { challenge } = pkcePair();
  const mismatch = setupOAuth({ cimdDoc: { client_id: "https://claude.ai/other", redirect_uris: [CALLBACK] } });
  const evil = setupOAuth({ cimdDoc: { client_id: "https://evil.example/meta", redirect_uris: [CALLBACK] } });
  const badRedirect = setupOAuth({ cimdDoc: { client_id: CIMD_CLIENT_ID, redirect_uris: ["https://evil.example/cb"] } });
  try {
    const r1 = await mismatch.handler.fetch(new Request(authorizeUrl(CIMD_CLIENT_ID, challenge)));
    assert.equal(r1?.status, 400);
    assert.match(await r1!.text(), /拒否/);
    const r2 = await evil.handler.fetch(new Request(authorizeUrl("https://evil.example/meta", challenge)));
    assert.equal(r2?.status, 400);
    assert.deepEqual(evil.fetched, [], "must not fetch hosts outside the allow-list (SSRF)");
    const r3 = await badRedirect.handler.fetch(new Request(authorizeUrl(CIMD_CLIENT_ID, challenge)));
    assert.equal(r3?.status, 400);
  } finally { mismatch.cleanup(); evil.cleanup(); badRedirect.cleanup(); }
});

test("DCR fallback: accepts subset grant_types, rejects redirect URIs outside the allow-list", async () => {
  const t = setupOAuth();
  try {
    const ok = await t.handler.fetch(new Request(`${BASE}/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    }));
    assert.equal(ok?.status, 201);
    const bad = await t.handler.fetch(new Request(`${BASE}/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x", redirect_uris: ["https://evil.example/cb"] }),
    }));
    assert.equal(bad?.status, 400);
    assert.deepEqual(await bad!.json(), { error: "invalid_redirect_uri" });
  } finally { t.cleanup(); }
});
