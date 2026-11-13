import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createOcrFixtureDatabase } from "../../../test/support/ocr-fixture.js";
import { OcrRepository } from "./repository.js";
import { ClientSafeError, describeForLog } from "../../shared/errors.js";

test("non-search OCR reads provide stats, labels, and bounded records", () => {
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "020.webp", text: "sample OCR text", reviewed: 1 },
    { id: 2, label: "Book A", fileName: "021.webp", text: "another OCR text", reviewed: 0 },
    { id: 3, label: "Book B", fileName: "001.webp", text: "third OCR text", reviewed: 2 },
    { id: 4, label: "Book C", fileName: "001.webp", text: "fourth OCR text", reviewed: null },
  ]);
  const repo = new OcrRepository(db);
  assert.deepEqual(repo.getStats(), { total: 4, reviewed: 3, unreviewed: 1, labels: 3 });
  assert.deepEqual(repo.listLabels(2).map((row) => ({ ...row })), [
    { label: "Book A", count: 2 },
    { label: "Book B", count: 1 },
  ]);
  const record = repo.getById(1, 1000);
  assert.equal(record?.file_name, "020.webp");
  assert.equal(record?.ocr_text, "sample OCR text");
  assert.equal(repo.getById(999, 1000), undefined);
  repo.close();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_images").get()?.count, 4,
    "repository close must not close the caller-owned DB");
  db.close();
});

test("getById truncation never splits a UTF-16 surrogate pair", () => {
  const text = `${"a".repeat(99)}𠮷tail`;
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "001.webp", text, reviewed: 0 },
  ]);
  const record = new OcrRepository(db).getById(1, 100)!;
  assert.equal(record.ocr_text, "a".repeat(99));
  assert.equal(record.truncated, true);
  assert.equal(record.ocr_text.includes("𠮷"), false);
  db.close();
});

test("non-search reads fail closed with a fixed message when the OCR DB is unavailable", () => {
  const repo = new OcrRepository(undefined, "permission denied: /secret/place/ocr.sqlite");
  for (const call of [() => repo.getStats(), () => repo.listLabels(), () => repo.getById(1, 1000)]) {
    assert.throws(call, (error: unknown) => {
      assert.ok(error instanceof ClientSafeError);
      assert.equal(error.message, "OCR database is unavailable");
      assert.ok(!error.message.includes("/secret/place"));
      assert.match(describeForLog(error), /permission denied: \/secret\/place\/ocr\.sqlite/);
      return true;
    });
  }
});

test("statistics use the shared fail-closed review semantics", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE source_images (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, ocr_text TEXT, reviewed INTEGER);
    INSERT INTO source_images VALUES (1, 'Book A', '001.webp', 'alpha one', 1);
    INSERT INTO source_images VALUES (2, 'Book A', '002.webp', 'alpha two', 0);
    INSERT INTO source_images VALUES (3, 'Book A', '003.webp', 'alpha three', 2);
    INSERT INTO source_images VALUES (4, 'Book A', '004.webp', 'alpha four', NULL);
  `);
  assert.deepEqual(new OcrRepository(db).getStats(), { total: 4, reviewed: 3, unreviewed: 1, labels: 1 });
  db.close();
});
