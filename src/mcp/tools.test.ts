import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AppConfig } from "../config/types.js";
import type { OcrRepository } from "../features/ocr/repository.js";
import { ClientSafeError } from "../shared/errors.js";
import { testConfig } from "../../test/support/oauth-kit.js";
import { startHttpServer } from "../http/server.js";
import { createMcpHttpHandler } from "./http-handler.js";
import { createMcpToolSchemas } from "./tools.js";

// ツール層の最後の砦: リポジトリが想定外の例外 (SQLite / fs のエラーなど、ローカルパスを含みうる) を投げても、
// クライアントには汎用文言だけが返り、ClientSafeError のメッセージだけがそのまま通ることを確認する。

const SECRET = "/secret/place/ocr.sqlite";
const raw = () => { throw new Error(`SQLITE_IOERR: disk I/O error while reading ${SECRET}`); };

async function withRepo(repo: Partial<Record<keyof OcrRepository, unknown>>, run: (call: (name: string, args?: unknown) => Promise<{ isError?: boolean; text: string }>) => Promise<void>) {
  const config: AppConfig = { ...testConfig, auth: { mode: "none" } };
  const server = startHttpServer(config, createMcpHttpHandler(repo as unknown as OcrRepository, config));
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  try {
    await run(async (name, args = {}) => {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      assert.equal(res.status, 200);
      const data = (await res.text()).split("\n").find((l) => l.startsWith("data: "))!;
      const result = (JSON.parse(data.slice(6)) as { result: { isError?: boolean; content: Array<{ text?: string }> } }).result;
      return { isError: result.isError, text: result.content.map((c) => c.text ?? "").join("\n") };
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("raw exceptions from the repository become a generic message; the local path never reaches the client", async () => {
  await withRepo({ search: raw, getById: raw, listLabels: raw, getStats: raw }, async (call) => {
    for (const [tool, args] of [["search_ocr", { query: "sample" }], ["get_ocr_record", { id: 1 }], ["list_source_labels", {}], ["get_ocr_stats", {}]] as const) {
      const out = await call(tool, args);
      assert.equal(out.isError, true, tool);
      assert.deepEqual(JSON.parse(out.text), { error: "OCR database operation failed" }, tool);
      assert.ok(!out.text.includes("/secret") && !/SQLITE|I\/O/.test(out.text), `${tool}: ${out.text}`);
    }
  });
});

test("ClientSafeError messages pass through unchanged", async () => {
  await withRepo({ listLabels: () => { throw new ClientSafeError("OCR database is unavailable"); } }, async (call) => {
    const out = await call("list_source_labels");
    assert.equal(out.isError, true);
    assert.deepEqual(JSON.parse(out.text), { error: "OCR database is unavailable" });
  });
});

test("a missing record is an ordinary tool error, not an exception", async () => {
  await withRepo({ getById: () => undefined }, async (call) => {
    const out = await call("get_ocr_record", { id: 999 });
    assert.equal(out.isError, true);
    assert.deepEqual(JSON.parse(out.text), { error: "Record not found", id: 999 });
  });
});

test("search_ocr maxLimit is enforced independently for each configuration", () => {
  const configLow: AppConfig = { ...testConfig, search: { ...testConfig.search, maxLimit: 7 } };
  const configHigh: AppConfig = { ...testConfig, search: { ...testConfig.search, maxLimit: 37 } };
  const lowSchema = createMcpToolSchemas(configLow).searchOcr;
  const highSchema = createMcpToolSchemas(configHigh).searchOcr;

  assert.equal(lowSchema.safeParse({ query: "sample", limit: 7 }).success, true);
  assert.equal(lowSchema.safeParse({ query: "sample", limit: 8 }).success, false);
  assert.equal(highSchema.safeParse({ query: "sample", limit: 37 }).success, true);
  assert.equal(highSchema.safeParse({ query: "sample", limit: 38 }).success, false);
});

test("search_ocr rejects a limit above configured maxLimit through the registered MCP tool", async () => {
  const config: AppConfig = {
    ...testConfig,
    auth: { mode: "none" },
    search: { ...testConfig.search, maxLimit: 7 },
  };
  let searchCalls = 0;
  const server = startHttpServer(config, createMcpHttpHandler({
    search: () => { searchCalls++; return []; },
  } as unknown as OcrRepository, config));
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "search_ocr", arguments: { query: "sample", limit: 8 } },
      }),
    });
    const body = await res.text();
    assert.ok(!res.ok || /error|invalid|limit/i.test(body), "the MCP request should report input validation failure");
    assert.equal(searchCalls, 0, "the repository must not be called for an over-limit request");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
