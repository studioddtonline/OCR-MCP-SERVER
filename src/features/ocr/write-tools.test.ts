import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createTempDir, removeTempDir } from "../../../test/support/temp-dir.js";
import { createOcrFixtureDatabase } from "../../../test/support/ocr-fixture.js";
import { testConfig } from "../../../test/support/oauth-kit.js";
import { OcrRepository } from "./repository.js";
import { openReadOnlyDatabase } from "./sqlite.js";
import { OcrWriteRepository } from "./write-repository.js";
import { OAuthStore } from "../../auth/oauth-store.js";
import { TokenStore } from "../../auth/token-store.js";
import { SCOPE_WRITE } from "../../auth/scopes.js";
import { startHttpServer } from "../../http/server.js";
import { createMcpHttpHandler } from "../../mcp/http-handler.js";
import type { AppConfig } from "../../config/types.js";

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

async function callTool(url: string, token: string, args: unknown) {
  const response = await fetch(url, {
    method: "POST", headers: { ...headers, authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_ocr_text", arguments: args } }),
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const data = raw.split("\n").find((line) => line.startsWith("data: "))!;
  const result = (JSON.parse(data.slice(6)) as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  return { isError: result.isError, value: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
}

test("update_ocr_text requires ocr:write and rejects reviewed rows through the real HTTP auth gateway", async () => {
  const dir = createTempDir("ocr-write-tool-http-");
  const dbPath = join(dir, "ocr.sqlite");
  const rawDb = createOcrFixtureDatabase(dbPath, [
    { id: 1, label: "Book A", fileName: "020.webp", text: "Reviewed text", reviewed: 1 },
    { id: 2, label: "Book A", fileName: "021.webp", text: "Unreviewed text", reviewed: 0 },
  ]);
  rawDb.exec(`
    CREATE TRIGGER source_images_au AFTER UPDATE OF ocr_text ON source_images BEGIN
      INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
      INSERT INTO images_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
    END;
  `);
  rawDb.close();

  const oauthStore = new OAuthStore(join(dir, "oauth.sqlite"));
  const tokens = new TokenStore(join(dir, "tokens.sqlite"));
  const readOnlyToken = tokens.create({ name: "read-only", purpose: "api" }).token;
  const writeToken = tokens.create({ name: "writer", purpose: "api", scopes: [SCOPE_WRITE] }).token;
  const readerDb = openReadOnlyDatabase({ path: dbPath, busyTimeoutMs: 1000 });
  const writer = OcrWriteRepository.open(dbPath, { log: () => undefined });
  const config: AppConfig = {
    ...testConfig,
    database: { path: dbPath, busyTimeoutMs: 1000 },
    ocrWrite: { enabled: true },
  };
  const server = startHttpServer(
    config,
    createMcpHttpHandler(new OcrRepository(readerDb), config, { repository: writer, log: () => undefined }),
    { status: "ready", store: oauthStore, tokens },
  );
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  try {
    const denied = await callTool(url, readOnlyToken, { id: 2, newText: "No permission text" });
    assert.equal(denied.isError, true);
    assert.equal(denied.value.code, "insufficient_scope");

    const protectedRow = await callTool(url, writeToken, { id: 1, newText: "Reviewed text" });
    assert.equal(protectedRow.isError, true);
    assert.equal(protectedRow.value.code, "reviewed_record_protected");

    const updated = await callTool(url, writeToken, { id: 2, newText: "New complete OCR text" });
    assert.equal(updated.isError, undefined);
    assert.equal(updated.value.changed, true);
    assert.equal(readerDb.prepare("SELECT ocr_text FROM source_images WHERE id = 2").get()?.ocr_text, "New complete OCR text");
    assert.equal(Number(readerDb.prepare("SELECT COUNT(*) AS count FROM mcp_ocr_edit_history").get()?.count), 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    readerDb.close();
    writer.close();
    oauthStore.close();
    tokens.close();
    removeTempDir(dir);
  }
});
