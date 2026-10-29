import test from "node:test";
import assert from "node:assert/strict";
import { createOcrFixtureDatabase } from "../../../test/support/ocr-fixture.js";
import { OcrRepository } from "./repository.js";
import { ClientSafeError, describeForLog } from "../../shared/errors.js";

test("getStats and label listing work against a minimal schema", () => {
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "020.webp", text: "sample OCR text", reviewed: 1 },
    { id: 2, label: "Book A", fileName: "021.webp", text: "another OCR text", reviewed: 0 }
  ]);
  const repo = new OcrRepository(db);
  assert.deepEqual(repo.getStats(), {
    total: 2,
    reviewed: 1,
    unreviewed: 1,
    labels: 1,
  });
  assert.deepStrictEqual(
    repo.listLabels().map((row) => ({ ...row })),
    [{ label: "Book A", count: 2 }],
  );
  assert.equal(repo.getById(1, 1000)?.file_name, "020.webp");
  db.close();
});



test("search uses a keyset cursor for follow-up pages and preserves ID order", () => {
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "001.webp", text: "sample OCR one", reviewed: 0 },
    { id: 2, label: "Book A", fileName: "002.webp", text: "sample OCR two", reviewed: 0 },
    { id: 3, label: "Book B", fileName: "003.webp", text: "sample OCR three", reviewed: 1 },
  ]);
  const repo = new OcrRepository(db);
  const first = repo.search({ query: "sample", limit: 1, offset: 0, snippetLength: 80 });
  assert.deepEqual(first.results.map((row) => row.id), [1]);
  assert.equal(first.nextAfterId, 1);

  const second = repo.search({ query: "sample", limit: 1, offset: 0, afterId: first.nextAfterId!, snippetLength: 80 });
  assert.deepEqual(second.results.map((row) => row.id), [2]);
  assert.equal(second.nextAfterId, 2);

  const third = repo.search({ query: "sample", limit: 2, offset: 0, afterId: second.nextAfterId!, snippetLength: 80 });
  assert.deepEqual(third.results.map((row) => row.id), [3]);
  assert.equal(third.nextAfterId, null, "no cursor is returned when there is no next page");
  assert.throws(() => repo.search({ query: "sample", limit: 1, offset: 2, afterId: 1, snippetLength: 80 }), /Use afterId or offset/);
  db.close();
});

test("label listing applies its limit in SQLite", () => {
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book C", fileName: "001.webp", text: "one sample", reviewed: 0 },
    { id: 2, label: "Book A", fileName: "002.webp", text: "two sample", reviewed: 0 },
    { id: 3, label: "Book B", fileName: "003.webp", text: "three sample", reviewed: 1 },
  ]);
  const repo = new OcrRepository(db);
  assert.deepEqual(repo.listLabels(2).map((row) => ({ ...row })), [
    { label: "Book A", count: 1 },
    { label: "Book B", count: 1 },
  ]);
  db.close();
});

test("database startup failure is a fixed client-safe message; the cause stays in the log-only chain", () => {
  const repo = new OcrRepository(undefined, "permission denied: /secret/place/ocr.sqlite");
  for (const call of [() => repo.getStats(), () => repo.listLabels()]) {
    assert.throws(call, (error: unknown) => {
      assert.ok(error instanceof ClientSafeError);
      assert.equal(error.message, "OCR database is unavailable");
      assert.ok(!error.message.includes("/secret/place"), "the local path must not be in the client-visible message");
      assert.match(describeForLog(error), /permission denied: \/secret\/place\/ocr\.sqlite/, "but it is available for server logs");
      return true;
    });
  }
});

test("a too-short search query is a client-safe validation error", () => {
  const repo = new OcrRepository(undefined);
  assert.throws(() => repo.search({ query: "ab", limit: 5, offset: 0, snippetLength: 100 }), ClientSafeError);
});
