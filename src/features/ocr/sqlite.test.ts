import { createTempDir, removeTempDir } from "../../../test/support/temp-dir.js";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { OcrRepository } from "./repository.js";
import { openReadOnlyDatabase, validateOcrSchema } from "./sqlite.js";
import { SOURCE_IMAGES_SCHEMA_SQL, IMAGES_FTS_SCHEMA_SQL } from "../../../test/support/ocr-fixture.js";

const GOOD_SOURCE = SOURCE_IMAGES_SCHEMA_SQL;
const GOOD_FTS = IMAGES_FTS_SCHEMA_SQL;
const SEED = `INSERT INTO source_images VALUES (1, 'Book A', '020.webp', 'sample OCR one', 1); INSERT INTO images_fts(images_fts) VALUES ('rebuild');`;

function withDb(sql: string, run: (open: () => DatabaseSync, path: string) => void) {
  const dir = createTempDir("schema-test-");
  const path = join(dir, "ocr.sqlite");
  const writer = new DatabaseSync(path);
  writer.exec(sql);
  writer.close();
  try {
    run(() => openReadOnlyDatabase({ path, busyTimeoutMs: 1000 }), path);
  } finally {
    removeTempDir(dir);
  }
}

test("a complete schema passes, and the tools then actually work against it", () => {
  withDb(`${GOOD_SOURCE} ${GOOD_FTS} ${SEED}`, (open) => {
    const db = open();
    try {
      const repo = new OcrRepository(db);
      assert.equal(repo.getStats().total, 1);
      assert.equal(repo.search({ query: "sample", limit: 5, offset: 0, snippetLength: 80 }).returned, 1);
    } finally { db.close(); }
  });
});

test("extra columns, different column order and upper-case column names are fine (only what the code uses is required)", () => {
  withDb(`CREATE TABLE source_images (extra TEXT, REVIEWED INTEGER, Ocr_Text TEXT, FILE_NAME TEXT, file_path TEXT, id INTEGER PRIMARY KEY, more BLOB);
          CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text);`, (open) => {
    open().close();
  });
});

test("missing tables are rejected", () => {
  withDb(GOOD_SOURCE, (open) => assert.throws(open, /must contain source_images and images_fts/));
  withDb(GOOD_FTS.replace("content='source_images', content_rowid='id', ", "").replace(", tokenize='trigram'", ""), (open) =>
    assert.throws(open, /must contain source_images and images_fts/));
});

test("source_images without a required column is rejected at startup, naming every missing column", () => {
  const fts = `CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text);`;
  withDb(`CREATE TABLE source_images (id INTEGER PRIMARY KEY); ${fts}`, (open) =>
    assert.throws(open, /missing required column\(s\): file_path, file_name, ocr_text, reviewed/));
  withDb(`CREATE TABLE source_images (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, ocr_text TEXT); ${fts}`, (open) =>
    assert.throws(open, /missing required column\(s\): reviewed$/));
  withDb(`CREATE TABLE source_images (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, reviewed INTEGER); ${fts}`, (open) =>
    assert.throws(open, /missing required column\(s\): ocr_text$/));
  // 以前は、列が欠けていても「起動時検証を通過 → 最初のツール呼び出しで `no such column`」になっていた
});

test("an images_fts that is not an FTS5 virtual table is rejected", () => {
  withDb(`${GOOD_SOURCE} CREATE TABLE images_fts (x TEXT);`, (open) => assert.throws(open, /images_fts must be an FTS5 virtual table/));
  withDb(`${GOOD_SOURCE} CREATE VIRTUAL TABLE images_fts USING fts4(ocr_text);`, (open) => assert.throws(open, /images_fts must be an FTS5 virtual table/));
});

test("a MATCH-probe failure is wrapped as a schema validation error", () => {
  // FTS5 のシャドウテーブルは SQLite のバージョンやビルド設定によって直接 DROP できず、
  // 壊れた FTS5 DB を実ファイルで作る方法が環境依存になる。ここでは正常な SQLite スキーマを用意し、
  // MATCH クエリだけを失敗させて、validateOcrSchema がエラーを正しく包むことを直接検証する。
  const db = new DatabaseSync(":memory:");
  db.exec(`${GOOD_SOURCE} ${GOOD_FTS}`);
  const failingMatchDb = {
    prepare(sql: string) {
      if (sql.includes("images_fts MATCH ?")) {
        return { get: () => { throw new Error("simulated SQLite MATCH failure"); } };
      }
      return db.prepare(sql);
    }
  } as unknown as DatabaseSync;

  try {
    assert.throws(() => validateOcrSchema(failingMatchDb), (error: unknown) => {
      assert.match((error as Error).message, /images_fts cannot be queried with MATCH/);
      assert.ok((error as Error).cause, "the underlying SQLite error is kept as the cause for the server log");
      assert.match(((error as Error).cause as Error).message, /simulated SQLite MATCH failure/);
      return true;
    });
  } finally {
    db.close();
  }
});

/** このプロセスが指定ファイルを開いている fd の数 (Linux の /proc/self/fd。無ければ undefined)。 */
function openFdCount(path: string): number | undefined {
  if (!existsSync("/proc/self/fd")) return undefined;
  let count = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    try { if (readlinkSync(`/proc/self/fd/${fd}`) === path) count += 1; } catch { /* fd が閉じられた */ }
  }
  return count;
}

test("the database handle is closed when validation fails (no leaked file descriptor)", { skip: !existsSync("/proc/self/fd") && "needs /proc/self/fd (Linux)" }, () => {
  withDb(`CREATE TABLE source_images (id INTEGER PRIMARY KEY); CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text);`, (open, path) => {
    assert.equal(openFdCount(path), 0, "precondition: nothing holds the file open");
    for (let i = 0; i < 5; i += 1) assert.throws(open);
    assert.equal(openFdCount(path), 0, "failed validations must not leave the database open");
  });
});
