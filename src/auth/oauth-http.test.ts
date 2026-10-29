import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, CALLBACK, RESOURCE, authorizeUrl, codeFrom, exchangeCode, pkcePair, postAuthorize, registerDcr, setupOAuth } from "../../test/support/oauth-kit.js";

test("DCR flow: register, consent with login token, PKCE, resource-bound tokens", async () => {
  const t = setupOAuth();
  try {
    const clientId = await registerDcr(t.handler);
    const { verifier, challenge } = pkcePair();

    const consent = await t.handler.fetch(new Request(authorizeUrl(clientId, challenge, { scope: "ocr:read" })));
    assert.equal(consent?.status, 200);
    assert.equal(consent!.headers.get("set-cookie"), null, "the consent page must not set a login cookie");
    assert.equal(consent!.headers.get("cache-control"), "no-store", "OAuth consent pages must not be cached");
    assert.equal(consent!.headers.get("x-frame-options"), "DENY", "OAuth consent pages must not be frameable");
    assert.equal(consent!.headers.get("x-content-type-options"), "nosniff", "OAuth consent pages must disable MIME sniffing");
    const html = await consent!.text();
    assert.match(html, /name="login_token"/);
    assert.match(html, /未検証/, "self-asserted DCR client names are labelled as unverified");

    const approval = await postAuthorize(t.handler, { clientId, challenge, loginToken: t.loginToken });
    assert.equal(approval?.status, 303);
    assert.equal(approval!.headers.get("set-cookie"), null, "approval must not create a reusable session");
    assert.equal(approval!.headers.get("cache-control"), "no-store", "authorization-code redirects must not be cached");
    const callback = new URL(approval!.headers.get("location")!);
    assert.equal(callback.origin + callback.pathname, CALLBACK);
    assert.equal(callback.searchParams.get("state"), "state-123");
    assert.equal(callback.searchParams.get("iss"), BASE);

    const tokenResponse = await exchangeCode(t.handler, clientId, codeFrom(approval), verifier, { resource: RESOURCE });
    assert.equal(tokenResponse?.status, 200);
    assert.equal(tokenResponse!.headers.get("cache-control"), "no-store", "OAuth token responses must not be cached");
    assert.equal(tokenResponse!.headers.get("pragma"), "no-cache", "OAuth token responses must disable legacy HTTP caching");
    const tokens = (await tokenResponse!.json()) as { access_token: string; scope: string };
    assert.equal(tokens.scope, "ocr:read");
    assert.equal(t.store.verifyAccessToken(tokens.access_token, RESOURCE)?.clientId, clientId);
    assert.equal(t.store.verifyAccessToken(tokens.access_token, "https://evil.example/mcp"), undefined);
  } finally { t.cleanup(); }
});

test("OAuth CORS preflight keeps the allowed origin, methods, headers, and max age", async () => {
  const t = setupOAuth();
  try {
    for (const path of ["/token", "/register", "/revoke"]) {
      const res = await t.handler.fetch(new Request(`${BASE}${path}`, {
        method: "OPTIONS",
        headers: {
          origin: BASE,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }));
      assert.equal(res?.status, 204, `${path} preflight status`);
      assert.equal(res!.headers.get("access-control-allow-origin"), "*", `${path} allowed origin`);
      assert.equal(res!.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS", `${path} allowed methods`);
      assert.equal(res!.headers.get("access-control-allow-headers"), "Content-Type, Authorization", `${path} allowed headers`);
      assert.equal(res!.headers.get("access-control-max-age"), "600", `${path} preflight cache duration`);
    }
  } finally { t.cleanup(); }
});

test("the old /login route and cookie-based login no longer exist", async () => {
  const t = setupOAuth();
  try {
    const res = await t.handler.fetch(new Request(`${BASE}/login`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams({ secret: t.loginToken, return_to: "/authorize?x=1" }),
    }));
    assert.equal(res, undefined);
  } finally { t.cleanup(); }
});
