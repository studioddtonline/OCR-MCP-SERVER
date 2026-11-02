import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { createOcrFixtureDatabase } from "../../../test/support/ocr-fixture.js";
import { OcrRepository } from "./repository.js";
import { SearchQuerySchema, type QueryNode } from "./query.js";
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

test("plain search accepts short literal terms and preserves keyset pagination", () => {
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "001.webp", text: "本文中に川がある", reviewed: 0 },
    { id: 2, label: "Book A", fileName: "002.webp", text: "川辺の風景", reviewed: 1 },
    { id: 3, label: "Book B", fileName: "003.webp", text: "河川敷", reviewed: 0 },
    { id: 4, label: "Book B", fileName: "004.webp", text: "湖畔", reviewed: 0 },
  ]);
  const repo = new OcrRepository(db);
  const first = repo.search({ query: "川", limit: 1, offset: 0, snippetLength: 80 });
  assert.deepEqual(first.results.map((row) => row.id), [1]);
  assert.equal(first.nextAfterId, 1);
  assert.match(first.results[0]!.snippet, /川/);

  const second = repo.search({ query: "川", limit: 1, offset: 0, afterId: first.nextAfterId!, snippetLength: 80 });
  assert.deepEqual(second.results.map((row) => row.id), [2]);
  assert.equal(second.nextAfterId, 2);

  const third = repo.search({ query: "川", limit: 1, offset: 0, afterId: second.nextAfterId!, snippetLength: 80 });
  assert.deepEqual(third.results.map((row) => row.id), [3], "short literal search must find a substring inside a longer word");
  assert.equal(third.nextAfterId, null);

  const filtered = repo.search({ query: "川", label: "Book A", reviewed: false, limit: 5, offset: 0, snippetLength: 80 });
  assert.deepEqual(filtered.results.map((row) => row.id), [1]);
  assert.throws(() => repo.search({ query: "川", limit: 1, offset: 1, afterId: 1, snippetLength: 80 }), /Use afterId or offset/);
  db.close();
});

test("structured search implements AND, OR, NOT, and nested combinations", () => {
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "001.webp", text: "宮崎監督のアニメ制作。ラピュタ。", reviewed: 0 },
    { id: 2, label: "Book A", fileName: "002.webp", text: "宮崎監督の映画。劇場版字幕", reviewed: 1 },
    { id: 3, label: "Book B", fileName: "003.webp", text: "ラピュタは映画です。字幕なし", reviewed: 0 },
    { id: 4, label: "Book B", fileName: "004.webp", text: "アニメ映画。", reviewed: 0 },
    { id: 5, label: "Book C", fileName: "005.webp", text: "東京特許許可局は有名です。川もある。", reviewed: 1 },
  ]);
  const repo = new OcrRepository(db);
  const common = { limit: 20, offset: 0, snippetLength: 100 };

  const and = repo.search({
    ...common,
    query: { type: "and", nodes: [
      { type: "term", value: "宮崎" },
      { type: "term", value: "監督" },
    ] },
  });
  assert.deepEqual(and.results.map((row) => row.id), [1, 2]);

  const or = repo.search({
    ...common,
    query: { type: "or", nodes: [
      { type: "term", value: "ラピュタ" },
      { type: "term", value: "アニメ" },
    ] },
  });
  assert.deepEqual(or.results.map((row) => row.id), [1, 3, 4]);

  const not = repo.search({
    ...common,
    query: { type: "and", nodes: [
      { type: "term", value: "宮崎" },
      { type: "not", node: { type: "term", value: "劇場版" } },
    ] },
  });
  assert.deepEqual(not.results.map((row) => row.id), [1]);

  const nested = repo.search({
    ...common,
    query: { type: "or", nodes: [
      { type: "and", nodes: [
        { type: "term", value: "宮崎" },
        { type: "term", value: "監督" },
      ] },
      { type: "and", nodes: [
        { type: "term", value: "ラピュタ" },
        { type: "not", node: { type: "term", value: "劇場版" } },
      ] },
    ] },
  });
  assert.deepEqual(nested.results.map((row) => row.id), [1, 2, 3]);

  const mixedLength = repo.search({
    ...common,
    query: { type: "and", nodes: [
      { type: "term", value: "東京特許" },
      { type: "term", value: "川" },
    ] },
  });
  assert.deepEqual(mixedLength.results.map((row) => row.id), [5], "short literals and trigram terms can be mixed in one AST");
  assert.match(mixedLength.results[0]!.snippet, /東京特許|川/);
  db.close();
});

test("structured search paginates in ID order and applies label and review filters to the full expression", () => {
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "001.webp", text: "宮崎監督 アニメ", reviewed: 0 },
    { id: 2, label: "Book A", fileName: "002.webp", text: "宮崎監督 映画", reviewed: 1 },
    { id: 3, label: "Book B", fileName: "003.webp", text: "宮崎監督 アニメ", reviewed: 0 },
  ]);
  const repo = new OcrRepository(db);
  const query: QueryNode = { type: "and", nodes: [
    { type: "term", value: "宮崎" },
    { type: "or", nodes: [
      { type: "term", value: "アニメ" },
      { type: "term", value: "映画" },
    ] },
  ] };
  const first = repo.search({ query, limit: 1, offset: 0, snippetLength: 80 });
  assert.deepEqual(first.results.map((row) => row.id), [1]);
  assert.equal(first.nextAfterId, 1);
  const second = repo.search({ query, limit: 1, offset: 0, afterId: first.nextAfterId!, snippetLength: 80 });
  assert.deepEqual(second.results.map((row) => row.id), [2]);
  assert.equal(second.nextAfterId, 2, "ID 3 also matches, so the second page must expose a next cursor");
  const third = repo.search({ query, limit: 1, offset: 0, afterId: second.nextAfterId!, snippetLength: 80 });
  assert.deepEqual(third.results.map((row) => row.id), [3]);
  assert.equal(third.nextAfterId, null);
  const filtered = repo.search({ query, label: "Book B", reviewed: false, limit: 10, offset: 0, snippetLength: 80 });
  assert.deepEqual(filtered.results.map((row) => row.id), [3]);
  db.close();
});

test("structured query rejects NOT-only, empty terms, excessive depth and excessive node counts", () => {
  const repo = new OcrRepository(undefined);
  const options = { limit: 5, offset: 0, snippetLength: 80 };
  assert.throws(() => repo.search({ ...options, query: { type: "not", node: { type: "term", value: "宮崎" } } }), /positive term/);
  assert.throws(() => repo.search({ ...options, query: { type: "term", value: "   " } }), ClientSafeError);
  let tooDeep: unknown = { type: "term", value: "宮崎" };
  for (let i = 0; i < 8; i++) tooDeep = { type: "not", node: tooDeep as QueryNode };
  // Eight NOT nodes still leave a positive term, but exceed the root-plus-eight-level limit.
  assert.throws(() => repo.search({ ...options, query: tooDeep as QueryNode }), /nested at most/);
  const tooMany: QueryNode = { type: "and", nodes: Array.from({ length: 16 }, (_, index) => ({
    type: "and" as const,
    nodes: [
      { type: "term" as const, value: `語${index}` },
      { type: "term" as const, value: `字${index}` },
    ],
  })) };
  assert.throws(() => repo.search({ ...options, query: tooMany }), /at most 32 nodes/);
  assert.throws(() => repo.search({ ...options, query: `😀${"a".repeat(500)}` }), /at most 500 Unicode code points/);
});

test("deep structured query is rejected iteratively before recursive schema parsing can overflow", () => {
  let query: unknown = { type: "term", value: "検索" };
  for (let index = 0; index < 20_000; index += 1) query = { type: "not", node: query };

  // MCP's Zod boundary validates only the root structure; nested nodes stay opaque here.
  assert.equal(SearchQuerySchema.safeParse(query).success, true);
  const repo = new OcrRepository(undefined);
  assert.throws(() => repo.search({ query, limit: 5, offset: 0, snippetLength: 80 }), /nested at most/);
});

test("FTS phrases are bound as data, including quotes and FTS operator-looking text", () => {
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "001.webp", text: 'A "quoted" phrase', reviewed: 0 },
    { id: 2, label: "Book A", fileName: "002.webp", text: "ordinary text", reviewed: 0 },
  ]);
  const repo = new OcrRepository(db);
  const quoted = repo.search({ query: '"quoted"', limit: 10, offset: 0, snippetLength: 80 });
  assert.deepEqual(quoted.results.map((row) => row.id), [1]);
  const injectionLike = repo.search({ query: 'x") OR 1=1 --', limit: 10, offset: 0, snippetLength: 80 });
  assert.deepEqual(injectionLike.results, []);
  db.close();
});


test("snippet offsets remain correct when Unicode lowercasing expands İ", () => {
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "001.webp", text: `${"İ".repeat(50)} target phrase appears here`, reviewed: 0 },
  ]);
  const repo = new OcrRepository(db);
  const result = repo.search({
    query: { type: "and", nodes: [
      { type: "term", value: "TARGET" },
      { type: "term", value: "PHRASE" },
    ] },
    limit: 5,
    offset: 0,
    snippetLength: 60,
  });
  assert.equal(result.returned, 1);
  assert.match(result.results[0]!.snippet, /target phrase/i);
  assert.ok(!/^…$/.test(result.results[0]!.snippet));
  db.close();
});

test("snippets and getById never split a UTF-16 surrogate pair", () => {
  const text = `${"a".repeat(159)}𠮷${"b".repeat(20)}`;
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "001.webp", text, reviewed: 0 },
  ]);
  const repo = new OcrRepository(db);
  const result = repo.search({ query: "a", limit: 5, offset: 0, snippetLength: 160 });
  assert.equal(result.returned, 1);
  assert.ok(result.results[0]!.snippet.includes("𠮷"), "the full supplementary-plane character must remain intact");
  const record = repo.getById(1, 160)!;
  assert.equal(record.ocr_text.length, 159, "truncation backs up rather than return an isolated high surrogate");
  assert.equal(record.ocr_text.includes("𠮷"), false);
  assert.equal(record.snippet.length, 159);
  db.close();
});

test("review-state filters and statistics use the same fail-closed semantics", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE source_images (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, ocr_text TEXT, reviewed INTEGER);
    CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text, content='source_images', content_rowid='id', tokenize='trigram');
    INSERT INTO source_images VALUES (1, 'Book A', '001.webp', 'alpha one', 1);
    INSERT INTO source_images VALUES (2, 'Book A', '002.webp', 'alpha two', 0);
    INSERT INTO source_images VALUES (3, 'Book A', '003.webp', 'alpha three', 2);
    INSERT INTO source_images VALUES (4, 'Book A', '004.webp', 'alpha four', NULL);
    INSERT INTO images_fts(images_fts) VALUES ('rebuild');
  `);
  const repo = new OcrRepository(db);
  assert.deepEqual(repo.getStats(), { total: 4, reviewed: 3, unreviewed: 1, labels: 1 });
  assert.deepEqual(repo.search({ query: "alpha", reviewed: true, limit: 10, offset: 0, snippetLength: 60 }).results.map((row) => row.id), [1, 3, 4]);
  assert.deepEqual(repo.search({ query: "alpha", reviewed: false, limit: 10, offset: 0, snippetLength: 60 }).results.map((row) => row.id), [2]);
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

test("search accepts a one-character query as a literal substring", () => {
  const db = createOcrFixtureDatabase(":memory:", [
    { id: 1, label: "Book A", fileName: "001.webp", text: "川辺", reviewed: 0 },
  ]);
  const repo = new OcrRepository(db);
  assert.equal(repo.search({ query: "川", limit: 5, offset: 0, snippetLength: 100 }).returned, 1);
  db.close();
});


test("prepared search statements use a bounded LRU cache", () => {
  const preparedSql: string[] = [];
  const fakeDb = {
    prepare(sql: string) {
      preparedSql.push(sql);
      return { all: () => [] };
    },
  } as unknown as DatabaseSync;
  const repo = new OcrRepository(fakeDb);

  const makeQuery = (mask: number): QueryNode => {
    let node: QueryNode = { type: "term", value: "root" };
    for (let bit = 0; bit < 7; bit += 1) {
      node = {
        type: (mask & (1 << bit)) === 0 ? "and" : "or",
        nodes: [node, { type: "term", value: `term-${bit}` }],
      };
    }
    return node;
  };
  const search = (mask: number) => repo.search({
    query: makeQuery(mask),
    limit: 1,
    offset: 0,
    snippetLength: 40,
  });

  for (let mask = 0; mask < 64; mask += 1) search(mask);
  assert.equal(preparedSql.length, 64);

  // Reusing the oldest entry makes it most-recently-used.
  search(0);
  assert.equal(preparedSql.length, 64);

  // The 65th SQL shape evicts mask=1, not the recently reused mask=0.
  search(64);
  assert.equal(preparedSql.length, 65);
  search(0);
  assert.equal(preparedSql.length, 65);
  search(1);
  assert.equal(preparedSql.length, 66);
});
