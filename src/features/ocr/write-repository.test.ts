import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTempDir, removeTempDir } from "../../../test/support/temp-dir.js";
import { createOcrFixtureDatabase } from "../../../test/support/ocr-fixture.js";
import { openReadOnlyDatabase } from "./sqlite.js";
import { OcrRepository } from "./repository.js";
import { OcrWriteError, OcrWriteRepository, MAX_OCR_TEXT_CODE_UNITS, OCR_HISTORY_WARNING_BYTES } from "./write-repository.js";

function createFtsMaintenanceTriggers(db: DatabaseSync): void {
  db.exec(`
    CREATE TRIGGER source_images_ai AFTER INSERT ON source_images BEGIN
      INSERT INTO images_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
    END;
    CREATE TRIGGER source_images_ad AFTER DELETE ON source_images BEGIN
      INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
    END;
    CREATE TRIGGER source_images_au AFTER UPDATE OF ocr_text ON source_images BEGIN
      INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
      INSERT INTO images_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
    END;
  `);
}

function createDb(path: string): void {
  const db = createOcrFixtureDatabase(path, [
    { id: 1, label: "Book A", fileName: "020.webp", text: "Reviewed OCR text", reviewed: 1 },
    { id: 2, label: "Book A", fileName: "021.webp", text: "Original OCR text", reviewed: 0 },
  ]);
  createFtsMaintenanceTriggers(db);
  db.close();
}

test("write repository refuses to start when book-ocr FTS maintenance triggers are missing", () => {
  const dir = createTempDir("ocr-write-missing-fts-trigger-");
  const path = join(dir, "ocr.sqlite");
  const db = createOcrFixtureDatabase(path, [
    { id: 1, label: "Book A", fileName: "020.webp", text: "Original OCR text", reviewed: 0 },
  ]);
  db.close();
  try {
    assert.throws(() => OcrWriteRepository.open(path, { log: () => undefined }), /source_images_ai FTS maintenance trigger/);
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_ocr_edit_history'").get(), undefined,
        "startup validation must fail before creating the MCP history table");
    } finally { check.close(); }
  } finally {
    removeTempDir(dir);
  }
});

test("write repository rejects a named trigger that does not maintain images_fts", () => {
  const dir = createTempDir("ocr-write-invalid-fts-trigger-");
  const path = join(dir, "ocr.sqlite");
  const db = createOcrFixtureDatabase(path, [
    { id: 1, label: "Book A", fileName: "020.webp", text: "Original OCR text", reviewed: 0 },
  ]);
  db.exec(`
    CREATE TRIGGER source_images_ai AFTER INSERT ON source_images BEGIN
      SELECT 1;
    END;
    CREATE TRIGGER source_images_ad AFTER DELETE ON source_images BEGIN
      INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
    END;
    CREATE TRIGGER source_images_au AFTER UPDATE OF ocr_text ON source_images BEGIN
      INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
      INSERT INTO images_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
    END;
  `);
  db.close();
  try {
    assert.throws(() => OcrWriteRepository.open(path, { log: () => undefined }), /valid source_images_ai FTS maintenance trigger/);
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_ocr_edit_history'").get(), undefined);
    } finally { check.close(); }
  } finally {
    removeTempDir(dir);
  }
});

test("writes unreviewed OCR, records complete history, and leaves FTS maintenance to the existing trigger", () => {
  const dir = createTempDir("ocr-write-repository-");
  const path = join(dir, "ocr.sqlite");
  createDb(path);
  const writer = OcrWriteRepository.open(path, { log: () => undefined });
  let writerOpen = true;
  const readerDb = openReadOnlyDatabase({ path, busyTimeoutMs: 1000 });
  const reader = new OcrRepository(readerDb);
  try {
    const result = writer.writeText(2, "Revised OCR passage");
    assert.equal(result.changed, true);
    assert.equal(result.id, 2);
    assert.equal(result.reviewed, 0);
    assert.ok(result.historyId);
    assert.ok(result.changedAt && !Number.isNaN(Date.parse(result.changedAt)));

    assert.deepEqual(reader.getById(2, 20000)?.ocr_text, "Revised OCR passage");
    assert.equal(reader.search({ query: "Revised OCR", limit: 10, offset: 0, snippetLength: 80 }).returned, 1);
    assert.equal(reader.search({ query: "Original OCR", limit: 10, offset: 0, snippetLength: 80 }).returned, 0);

    const history = readerDb.prepare("SELECT source_image_id, old_text, new_text, changed_at FROM mcp_ocr_edit_history WHERE id = ?").get(result.historyId) as {
      source_image_id: number; old_text: string; new_text: string; changed_at: string;
    };
    assert.deepEqual({ source_image_id: history.source_image_id, old_text: history.old_text, new_text: history.new_text }, {
      source_image_id: 2, old_text: "Original OCR text", new_text: "Revised OCR passage",
    });
    assert.equal(history.changed_at, result.changedAt);
    assert.deepEqual(
      { ...(readerDb.prepare("SELECT old_bytes, new_bytes FROM mcp_ocr_edit_history WHERE id = ?").get(result.historyId) as { old_bytes: number; new_bytes: number }) },
      { old_bytes: Buffer.byteLength("Original OCR text", "utf8"), new_bytes: Buffer.byteLength("Revised OCR passage", "utf8") },
    );

    const noChange = writer.writeText(2, "Revised OCR passage");
    assert.deepEqual(noChange, { id: 2, changed: false, reviewed: 0 });
    assert.equal(Number(readerDb.prepare("SELECT COUNT(*) AS count FROM mcp_ocr_edit_history").get()?.count), 1);
    writer.close();
    writerOpen = false;
    const reopened = OcrWriteRepository.open(path, { log: () => undefined });
    try {
      assert.deepEqual(reopened.getHistoryEstimate(), {
        rows: 1,
        textBytes: Buffer.byteLength("Original OCR text", "utf8") + Buffer.byteLength("Revised OCR passage", "utf8"),
      });
    } finally { reopened.close(); }
  } finally {
    readerDb.close();
    if (writerOpen) writer.close();
    removeTempDir(dir);
  }
});

test("reviewed records are rejected even when the submitted body is identical", () => {
  const dir = createTempDir("ocr-write-reviewed-");
  const path = join(dir, "ocr.sqlite");
  createDb(path);
  const writer = OcrWriteRepository.open(path, { log: () => undefined });
  try {
    assert.throws(() => writer.writeText(1, "Reviewed OCR text"), (error: unknown) =>
      error instanceof OcrWriteError && error.code === "reviewed_record_protected");
    assert.throws(() => writer.writeText(999, "No record"), (error: unknown) =>
      error instanceof OcrWriteError && error.code === "record_not_found");
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(check.prepare("SELECT reviewed FROM source_images WHERE id = 1").get()?.reviewed, 1);
      assert.equal(Number(check.prepare("SELECT COUNT(*) AS count FROM mcp_ocr_edit_history").get()?.count), 0);
    } finally { check.close(); }
  } finally {
    writer.close();
    removeTempDir(dir);
  }
});

test("NULL and unexpected non-zero reviewed flags are protected from OCR writes", () => {
  const dir = createTempDir("ocr-write-invalid-reviewed-");
  const path = join(dir, "ocr.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE source_images (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, ocr_text TEXT, reviewed INTEGER);
    CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, content='source_images', content_rowid='id', tokenize='trigram');
    INSERT INTO source_images VALUES (1, 'Book A', '001.webp', 'Alpha reviewed', 2);
    INSERT INTO source_images VALUES (2, 'Book A', '002.webp', 'Alpha null flag', NULL);
    INSERT INTO images_fts(images_fts) VALUES ('rebuild');
    CREATE TRIGGER source_images_ai AFTER INSERT ON source_images BEGIN
      INSERT INTO images_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
    END;
    CREATE TRIGGER source_images_ad AFTER DELETE ON source_images BEGIN
      INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
    END;
    CREATE TRIGGER source_images_au AFTER UPDATE OF ocr_text ON source_images BEGIN
      INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
      INSERT INTO images_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
    END;
  `);
  db.close();
  const writer = OcrWriteRepository.open(path, { log: () => undefined });
  try {
    for (const id of [1, 2]) {
      assert.throws(() => writer.writeText(id, "Should remain protected"), (error: unknown) =>
        error instanceof OcrWriteError && error.code === "reviewed_record_protected");
    }
  } finally {
    writer.close();
    removeTempDir(dir);
  }
});

test("history insertion failure rolls back the OCR body update", () => {
  const dir = createTempDir("ocr-write-rollback-");
  const path = join(dir, "ocr.sqlite");
  createDb(path);
  const writer = OcrWriteRepository.open(path, { log: () => undefined });
  const control = new DatabaseSync(path);
  control.exec(`CREATE TRIGGER reject_mcp_history BEFORE INSERT ON mcp_ocr_edit_history BEGIN SELECT RAISE(ABORT, 'history refused'); END;`);
  try {
    assert.throws(() => writer.writeText(2, "Must roll back"), /history refused/);
    assert.equal(control.prepare("SELECT ocr_text FROM source_images WHERE id = 2").get()?.ocr_text, "Original OCR text");
    assert.equal(Number(control.prepare("SELECT COUNT(*) AS count FROM mcp_ocr_edit_history").get()?.count), 0);
  } finally {
    control.close();
    writer.close();
    removeTempDir(dir);
  }
});

test("new and existing OCR bodies beyond the size limits are rejected", () => {
  const dir = createTempDir("ocr-write-size-");
  const path = join(dir, "ocr.sqlite");
  createDb(path);
  const writer = OcrWriteRepository.open(path, { log: () => undefined });
  try {
    assert.throws(() => writer.writeText(2, "x".repeat(MAX_OCR_TEXT_CODE_UNITS + 1)), (error: unknown) =>
      error instanceof OcrWriteError && error.code === "invalid_input");
    assert.throws(() => writer.writeText(2, "😀".repeat(20_000)), (error: unknown) =>
      error instanceof OcrWriteError && error.code === "invalid_input");
  } finally {
    writer.close();
    removeTempDir(dir);
  }
});

test("history warning is emitted at startup when old_text + new_text reaches 10 MiB", () => {
  const dir = createTempDir("ocr-write-history-warning-");
  const path = join(dir, "ocr.sqlite");
  const db = createOcrFixtureDatabase(path, []);
  createFtsMaintenanceTriggers(db);
  db.exec(`CREATE TABLE mcp_ocr_edit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_image_id INTEGER NOT NULL,
    changed_at TEXT NOT NULL,
    old_text TEXT NOT NULL,
    new_text TEXT NOT NULL
  ) STRICT;`);
  db.prepare("INSERT INTO mcp_ocr_edit_history (source_image_id, changed_at, old_text, new_text) VALUES (?, ?, ?, ?)")
    .run(2, new Date().toISOString(), "x".repeat(OCR_HISTORY_WARNING_BYTES), "");
  db.close();
  const logs: string[] = [];
  const writer = OcrWriteRepository.open(path, { log: (...args) => logs.push(args.map(String).join(" ")) });
  try {
    assert.deepEqual(writer.getHistoryEstimate(), { rows: 1, textBytes: OCR_HISTORY_WARNING_BYTES });
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /history warning/);
    assert.match(logs[0]!, /10 MiB/);
    assert.match(logs[0]!, /no records were deleted/);
  } finally {
    writer.close();
    removeTempDir(dir);
  }
});
