import { createTempDir, removeTempDir } from "../../test/support/temp-dir.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import type { AppConfig } from "../config/types.js";
import { OcrRepository } from "../features/ocr/repository.js";
import { OAuthStore } from "../auth/oauth-store.js";
import { TokenStore } from "../auth/token-store.js";
import { testConfig } from "../../test/support/oauth-kit.js";
import { createOcrFixtureDatabase } from "../../test/support/ocr-fixture.js";
import { closeTestServer, waitForTestServer } from "../../test/support/http-server.js";
import { startHttpServer } from "./server.js";
import { createMcpHttpHandler } from "../mcp/http-handler.js";

// 多層防御: 認証なしで MCP を公開してよいのは auth.mode が明示的に "none" のときだけ。
// loadConfig の検証をすり抜けた設定や想定外の値が来ても、無認証公開 (200) にならないことを確認する。

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const statsCall = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_ocr_stats", arguments: {} } };

async function serve(config: AppConfig, withStores: boolean, run: (ctx: { url: string; apiToken: string }) => Promise<void>) {
  const dir = createTempDir("failclosed-test-");
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "020.webp", text: "sample OCR text", reviewed: 1 }
  ]);
  const store = new OAuthStore(join(dir, "oauth.sqlite"));
  const tokens = new TokenStore(join(dir, "tokens.sqlite"));
  const apiToken = tokens.create({ name: "t", purpose: "api" }).token;
  const server: Server = startHttpServer(config, createMcpHttpHandler(new OcrRepository(db), config), withStores ? { status: "ready", store, tokens } : undefined);
  const { base } = await waitForTestServer(server);
  try {
    await run({ url: `${base}/mcp`, apiToken });
  } finally {
    await closeTestServer(server);
    store.close(); tokens.close(); db.close();
    removeTempDir(dir);
  }
}
const post = (url: string, bearer?: string) =>
  fetch(url, { method: "POST", headers: { ...HEADERS, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(statsCall) });

test("auth.mode=oauth without publicBaseUrl (config validation bypassed): MCP is 503 even with valid stores and a valid token", async () => {
  const config: AppConfig = { ...testConfig, server: { ...testConfig.server, publicBaseUrl: undefined } };
  await serve(config, true, async ({ url, apiToken }) => {
    assert.equal((await post(url)).status, 503);
    assert.equal((await post(url, apiToken)).status, 503, "a valid token must not open a gate that could not be built");
  });
});

test("auth.mode=oauth with no OAuth options at all: MCP is 503", async () => {
  await serve(testConfig, false, async ({ url, apiToken }) => {
    assert.equal((await post(url)).status, 503);
    assert.equal((await post(url, apiToken)).status, 503);
  });
});

test("an unexpected auth.mode value fails closed", async () => {
  const config = { ...testConfig, auth: { mode: "bogus" } } as unknown as AppConfig;
  await serve(config, true, async ({ url, apiToken }) => {
    assert.equal((await post(url)).status, 503);
    assert.equal((await post(url, apiToken)).status, 503);
  });
});

test("auth.mode=none still serves MCP without credentials (the guard does not over-close)", async () => {
  const config: AppConfig = { ...testConfig, auth: { mode: "none" } };
  await serve(config, false, async ({ url }) => {
    const res = await post(url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /\\"total\\":\s*1/);
  });
});

test("auth.mode=oauth with working stores still authenticates normally (401 without token, 200 with)", async () => {
  await serve(testConfig, true, async ({ url, apiToken }) => {
    assert.equal((await post(url)).status, 401);
    assert.equal((await post(url, apiToken)).status, 200);
  });
});
