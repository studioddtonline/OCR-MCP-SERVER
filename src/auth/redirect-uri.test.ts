import { createTempDir, removeTempDir } from "../../test/support/temp-dir.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { OAuthStore, OAuthValidationError } from "./oauth-store.js";
import { createOAuthHandler } from "./oauth/index.js";
import { TokenStore } from "./token-store.js";
import { BASE, authorizeUrl, pkcePair, testConfig } from "../../test/support/oauth-kit.js";

// リダイレクト URI に許されるのは「HTTPS」または「HTTP かつループバックホスト」だけ。
// allowedRedirectUris (許可リスト) の後段にある検証で、許可リストの設定ミスがあってもスキームの穴にならないようにする。

const ACCEPT = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://localhost/cb",
  "http://localhost/cb",
  "http://localhost:3000/cb",
  "http://127.0.0.1:8080/cb",
  "http://[::1]:9000/cb",
];
const REJECT = [
  "ftp://localhost/callback",
  "ws://127.0.0.1/cb",
  "wss://localhost/cb",
  "myapp://localhost/cb",
  "cursor://anysphere.cursor-mcp/oauth/callback",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "data:text/html,x",
  "http://evil.example/cb",
  "http://localhost.evil.example/cb",
  "http://127.0.0.1.evil.example/cb",
  "http://example.com@localhost/cb",
  "https://user:pass@claude.ai/cb",
  "https://claude.ai/cb#fragment",
  "https://claude.ai/cb#",
  "https://@claude.ai/cb",
  "https://:@claude.ai/cb",
  "http://localhost/cb#",
  "http://@localhost/cb",
  "not a url",
  "",
];

function withStore(run: (store: OAuthStore, dir: string) => void | Promise<void>) {
  const dir = createTempDir("redirect-test-");
  const store = new OAuthStore(join(dir, "oauth.sqlite"));
  return Promise.resolve(run(store, dir)).finally(() => { store.close(); removeTempDir(dir); });
}

test("store: only https, or http on a loopback host, is accepted (registerClient and upsertClient)", async () => {
  await withStore((store) => {
    for (const uri of ACCEPT) {
      assert.doesNotThrow(() => store.registerClient({ clientName: "c", redirectUris: [uri] }), `should accept ${uri}`);
      assert.doesNotThrow(() => store.upsertClient({ clientId: `https://claude.ai/meta/${encodeURIComponent(uri)}`, clientName: "c", redirectUris: [uri] }), `should accept ${uri}`);
    }
    for (const uri of REJECT) {
      assert.throws(() => store.registerClient({ clientName: "c", redirectUris: [uri] }),
        (e: unknown) => e instanceof OAuthValidationError && e.oauthError === "invalid_redirect_uri", `should reject ${JSON.stringify(uri)}`);
      assert.throws(() => store.upsertClient({ clientId: "https://claude.ai/meta/x", clientName: "c", redirectUris: [uri] }),
        (e: unknown) => e instanceof OAuthValidationError, `should reject ${JSON.stringify(uri)}`);
    }
  });
});

test("one bad URI among good ones rejects the whole registration", async () => {
  await withStore((store) => {
    assert.throws(() => store.registerClient({ clientName: "c", redirectUris: ["https://claude.ai/cb", "ftp://localhost/cb"] }), OAuthValidationError);
  });
});

test("defense in depth: even if the allow-list is misconfigured with ftp://localhost/..., DCR and CIMD refuse it", async () => {
  await withStore(async (store, dir) => {
    const tokens = new TokenStore(join(dir, "tokens.sqlite"));
    const bad = "ftp://localhost/cb";
    const config = { ...testConfig, oauth: { ...testConfig.oauth!, allowedRedirectUris: [bad] } };
    const fetchImpl = (async () => new Response(JSON.stringify({
      client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata", client_name: "Claude", redirect_uris: [bad],
    }), { status: 200 })) as typeof fetch;
    const handler = createOAuthHandler(config, store, tokens, { fetchImpl });
    try {
      // DCR: 許可リストは通るが、ストア側の検証で 400 (invalid_redirect_uri)。DB 障害 (503) と取り違えない。
      const dcr = await handler.fetch(new Request(`${BASE}/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "x", redirect_uris: [bad] }),
      }));
      assert.equal(dcr?.status, 400);
      assert.deepEqual(await dcr!.json(), { error: "invalid_redirect_uri" });
      // CIMD: 同様に無効なクライアント扱い (400)
      const { challenge } = pkcePair();
      const cimd = await handler.fetch(new Request(authorizeUrl("https://claude.ai/oauth/mcp-oauth-client-metadata", challenge, { redirect_uri: bad })));
      assert.equal(cimd?.status, 400);
      assert.equal(store.getClient("https://claude.ai/oauth/mcp-oauth-client-metadata"), undefined, "nothing was persisted");
    } finally { tokens.close(); }
  });
});
