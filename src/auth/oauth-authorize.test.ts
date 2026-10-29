import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE, CIMD_CLIENT_ID, OTHER_CALLBACK, authorizeUrl, codeCount, codeFrom, exchangeCode, pkcePair, postAuthorize, registerDcr, setupOAuth,
} from "../../test/support/oauth-kit.js";

test("no login reuse: approving one client never authenticates another authorization", async () => {
  const t = setupOAuth();
  try {
    const claude = await registerDcr(t.handler, "Claude");
    const grok = await registerDcr(t.handler, "Grok", OTHER_CALLBACK);
    const { challenge } = pkcePair();

    const first = await postAuthorize(t.handler, { clientId: claude, challenge, loginToken: t.loginToken });
    assert.equal(first?.status, 303);
    assert.equal(first!.headers.get("set-cookie"), null);
    const codesAfterFirst = codeCount(t);

    // 直後に別クライアント (Grok) が認可を求めても、トークン無しでは通らない。Cookie を持っていても同じ。
    const second = await postAuthorize(t.handler, { clientId: grok, challenge, redirectUri: OTHER_CALLBACK });
    assert.equal(second?.status, 401);
    assert.equal(second!.headers.get("location"), null);
    assert.equal(codeCount(t), codesAfterFirst, "no authorization code may be issued without a token");

    // 認可画面 (GET) も毎回トークン入力欄を出す
    const page = await t.handler.fetch(new Request(authorizeUrl(grok, challenge, { redirect_uri: OTHER_CALLBACK }), { headers: { cookie: "ocr_oauth_session=anything" } }));
    assert.match(await page!.text(), /name="login_token"/);

    // トークンを入れ直せば通る
    const third = await postAuthorize(t.handler, { clientId: grok, challenge, redirectUri: OTHER_CALLBACK, loginToken: t.loginToken });
    assert.equal(third?.status, 303);
  } finally { t.cleanup(); }
});

test("wrong, empty, api-purpose and revoked login tokens are rejected without issuing a code", async () => {
  const t = setupOAuth();
  try {
    const clientId = await registerDcr(t.handler);
    const { challenge } = pkcePair();
    const apiToken = t.tokens.create({ name: "claude-code", purpose: "api" }).token;
    for (const bad of ["", "nope", `${t.loginToken}x`, apiToken]) {
      const res = await postAuthorize(t.handler, { clientId, challenge, loginToken: bad });
      assert.equal(res?.status, 401, `token ${JSON.stringify(bad.slice(0, 12))} must be rejected`);
      assert.match(await res!.text(), /正しくありません/);
    }
    assert.equal(codeCount(t), 0);

    t.tokens.revoke("owner");
    const revoked = await postAuthorize(t.handler, { clientId, challenge, loginToken: t.loginToken });
    assert.equal(revoked?.status, 401);
    assert.equal(codeCount(t), 0);
  } finally { t.cleanup(); }
});

test("failed attempts are rate limited per client address (even a valid token is refused while locked)", async () => {
  const t = setupOAuth();
  try {
    const clientId = await registerDcr(t.handler);
    const { challenge } = pkcePair();
    const post = (token: string, ip: string) => {
      const body = new URLSearchParams({
        client_id: clientId, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code", code_challenge: challenge,
        code_challenge_method: "S256", resource: `${BASE}/mcp`, scope: "ocr:read", state: "s", decision: "approve", login_token: token,
      });
      return t.handler.fetch(new Request(`${BASE}/authorize`, {
        method: "POST", body,
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, "x-forwarded-for": ip },
      }));
    };
    for (let i = 0; i < 10; i += 1) assert.equal((await post("wrong", "203.0.113.9"))?.status, 401);
    const locked = await post(t.loginToken, "203.0.113.9");
    assert.equal(locked?.status, 429);
    assert.ok(locked!.headers.get("retry-after"));
    assert.equal(locked!.headers.get("cache-control"), "no-store", "rate-limit responses must not be cached");
    // 別のアドレスは影響を受けない
    assert.equal((await post(t.loginToken, "198.51.100.7"))?.status, 303);
  } finally { t.cleanup(); }
});

test("denying needs no token, and always redirects with access_denied", async () => {
  const t = setupOAuth();
  try {
    const clientId = await registerDcr(t.handler);
    const { challenge } = pkcePair();
    const res = await postAuthorize(t.handler, { clientId, challenge, decision: "deny" });
    assert.equal(res?.status, 303);
    const location = new URL(res!.headers.get("location")!);
    assert.equal(location.searchParams.get("error"), "access_denied");
    assert.equal(location.searchParams.get("code"), null);
    assert.equal(location.searchParams.get("iss"), BASE, "denial redirect must identify the authorization server");
    assert.equal(res!.headers.get("cache-control"), "no-store", "authorization denial redirects must not be cached");
    assert.equal(codeCount(t), 0);
  } finally { t.cleanup(); }
});

test("POST /authorize requires the expected Origin", async () => {
  const t = setupOAuth();
  try {
    const clientId = await registerDcr(t.handler);
    const { challenge } = pkcePair();
    assert.equal((await postAuthorize(t.handler, { clientId, challenge, loginToken: t.loginToken, origin: null }))?.status, 403);
    assert.equal((await postAuthorize(t.handler, { clientId, challenge, loginToken: t.loginToken, origin: "https://evil.example" }))?.status, 403);
    assert.equal(codeCount(t), 0);
  } finally { t.cleanup(); }
});

test("ocr:write is an opt-in checkbox, only offered when requested, and never granted unchecked", async () => {
  const t = setupOAuth({ ocrWriteEnabled: true });
  try {
    const clientId = await registerDcr(t.handler);
    const { verifier, challenge } = pkcePair();
    const grantedScope = async (post: Parameters<typeof postAuthorize>[1]) => {
      const res = await postAuthorize(t.handler, post);
      const token = await exchangeCode(t.handler, clientId, codeFrom(res), verifier);
      return ((await token!.json()) as { scope: string }).scope;
    };

    const readOnlyPage = await (await t.handler.fetch(new Request(authorizeUrl(clientId, challenge, { scope: "ocr:read" }))))!.text();
    assert.doesNotMatch(readOnlyPage, /name="grant_scope"/, "write checkbox is not shown unless the client asks for it");
    const writePage = await (await t.handler.fetch(new Request(authorizeUrl(clientId, challenge, { scope: "ocr:read ocr:write" }))))!.text();
    assert.match(writePage, /name="grant_scope" value="ocr:write"(?![^>]*checked)/, "checkbox exists and is unchecked by default");

    assert.equal(await grantedScope({ clientId, challenge, loginToken: t.loginToken, scope: "ocr:read ocr:write" }), "ocr:read");
    assert.equal(await grantedScope({ clientId, challenge, loginToken: t.loginToken, scope: "ocr:read ocr:write", grantScopes: ["ocr:write"] }), "ocr:read ocr:write");
    // 要求されていないスコープは、フォームを細工してもチェック扱いにならない
    assert.equal(await grantedScope({ clientId, challenge, loginToken: t.loginToken, scope: "ocr:read", grantScopes: ["ocr:write"] }), "ocr:read");
    // 未知のスコープは無視される
    assert.equal(await grantedScope({ clientId, challenge, loginToken: t.loginToken, scope: "ocr:read admin", grantScopes: ["admin"] }), "ocr:read");
  } finally { t.cleanup(); }
});

test("consent page escapes self-asserted client names and labels them unverified; CIMD shows the verified host", async () => {
  const t = setupOAuth({ cimdDoc: { client_id: CIMD_CLIENT_ID, client_name: "<b>fake</b>", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] } });
  try {
    const dcr = await registerDcr(t.handler, `<script>alert(1)</script>`);
    const { challenge } = pkcePair();
    const dcrHtml = await (await t.handler.fetch(new Request(authorizeUrl(dcr, challenge))))!.text();
    assert.doesNotMatch(dcrHtml, /<script>alert/);
    assert.match(dcrHtml, /&lt;script&gt;/);
    assert.match(dcrHtml, /未検証/);
    const cimdHtml = await (await t.handler.fetch(new Request(authorizeUrl(CIMD_CLIENT_ID, challenge))))!.text();
    assert.match(cimdHtml, /claude\.ai/);
    assert.doesNotMatch(cimdHtml, /fake/, "CIMD client_name is self-asserted too, so only the verified host is shown");
  } finally { t.cleanup(); }
});
