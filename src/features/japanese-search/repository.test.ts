import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createTempDir, removeTempDir } from "../../../test/support/temp-dir.js";
import { JapaneseSearchRepository } from "./repository.js";
import { loadVaporettoExtension } from "../../../test/support/sqlite-vaporetto-extension.js";

const extensionPath = resolve(process.env.SQLITE_VAPORETTO_EXTENSION ?? "native/sqlite-vaporetto/libsqlite_vaporetto.so");
const SEARCHABLE_TOKEN = /[\p{L}\p{N}]/u;

function searchableTokens(value: unknown): string[] {
  return String(value ?? "")
    .split(/\s+/u)
    .filter((token) => token.length > 0 && SEARCHABLE_TOKEN.test(token));
}

test("sqlite-vaporetto index opens in a worker and searches a pretokenized contentless FTS5 index", { skip: !existsSync(extensionPath) }, async () => {
  const dir = createTempDir("japanese-search-test-");
  const indexPath = join(dir, "index.sqlite");
  const builder = new DatabaseSync(indexPath, { allowExtension: true });
  loadVaporettoExtension(builder, extensionPath);
  builder.enableLoadExtension(false);
  builder.exec(`
    CREATE TABLE japanese_search_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      tokenizer TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      source_record_count INTEGER NOT NULL,
      source_max_id INTEGER NOT NULL
    );
    INSERT INTO japanese_search_meta VALUES (1, 2, 'vaporetto-pretokenized-unicode61', '2026-01-01T00:00:00.000Z', 1, 7);
    CREATE TABLE japanese_documents (
      source_id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, reviewed INTEGER, ocr_text TEXT NOT NULL
    );
    INSERT INTO japanese_documents VALUES (7, 'テスト書籍', '001.webp', 1, '東京特許許可局');
    CREATE VIRTUAL TABLE japanese_fts USING fts5(search_text, content='', tokenize='unicode61');
  `);

  try {
    const tokenized = builder.prepare("SELECT vaporetto_split(?, ' ') AS tokens").get("東京特許許可局")?.tokens;
    const tokens = searchableTokens(tokenized);
    assert.ok(tokens.length > 0, "the Vaporetto tokenizer must produce searchable tokens");
    builder.prepare("INSERT INTO japanese_fts(rowid, search_text) VALUES (?, ?)").run(7, tokens.join(" "));
    builder.close();

    const repo = JapaneseSearchRepository.open({
      indexPath,
      extensionPath,
      busyTimeoutMs: 500,
      maxLimit: 10,
    });
    try {
      const result = await repo.search({ query: "東京特許許可局", mode: "any", limit: 10, offset: 0 }) as {
        returned: number;
        queryTokens: string[];
        results: Array<{ id: number; label: string; reviewed: number | null; snippet: string }>;
        index: { indexedRecords: number; tokenizer: string };
      };
      assert.equal(result.returned, 1);
      assert.equal(result.results[0]?.id, 7);
      assert.equal(result.results[0]?.label, "テスト書籍");
      assert.equal(result.results[0]?.reviewed, 1);
      assert.match(result.results[0]?.snippet ?? "", /〔東京〕/);
      assert.equal(result.index.indexedRecords, 1);
      assert.equal(result.index.tokenizer, "vaporetto-pretokenized-unicode61");
      assert.ok(result.queryTokens.includes("東京"));

      const allModeResult = await repo.search({ query: "東京特許許可局", mode: "all", limit: 10, offset: 0 }) as {
        returned: number;
      };
      assert.equal(allModeResult.returned, 1, "all mode must require all Vaporetto query tokens");

      const reviewedOnly = await repo.search({ query: "東京特許許可局", mode: "any", reviewed: true, limit: 10, offset: 0 }) as { returned: number };
      const unreviewedOnly = await repo.search({ query: "東京特許許可局", mode: "any", reviewed: false, limit: 10, offset: 0 }) as { returned: number };
      assert.equal(reviewedOnly.returned, 1);
      assert.equal(unreviewedOnly.returned, 0);
    } finally {
      repo.close();
    }
  } finally {
    try { builder.close(); } catch { /* Already closed after successful setup. */ }
    removeTempDir(dir);
  }
});


const fakeMetadata = {
  schema_version: 2,
  tokenizer: "vaporetto-pretokenized-unicode61",
  indexed_at: "2026-01-01T00:00:00.000Z",
  source_record_count: 1,
  source_max_id: 7,
};

class FakeJapaneseWorker extends EventEmitter {
  readonly posted: Array<Record<string, unknown>> = [];
  ready = false;
  terminated = false;

  constructor(private readonly autoStart = true, autoReady = true) {
    super();
    if (autoReady) {
      queueMicrotask(() => {
        this.ready = true;
        this.emit("message", { type: "ready", metadata: fakeMetadata });
      });
    }
  }

  postMessage(value: unknown): void {
    const message = value as Record<string, unknown>;
    this.posted.push(message);
    if (message.type === "search" && this.autoStart) this.emit("message", { type: "started", id: message.id });
  }

  respond(id: number): void {
    this.emit("message", { type: "result", id, ok: true, value: { id } });
  }

  terminate(): Promise<number> {
    this.terminated = true;
    queueMicrotask(() => this.emit("exit", 1));
    return Promise.resolve(1);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function fakeRepositoryOptions(
  dir: string,
  workers: FakeJapaneseWorker[],
  extra: {
    executionTimeoutMs?: number;
    startupTimeoutMs?: number;
    queueWaitTimeoutMs?: number;
    restartBaseDelayMs?: number;
    restartMaxDelayMs?: number;
    maxRestartAttempts?: number;
    firstWorkerAutoStart?: boolean;
    autoReady?: boolean;
    log?: (...args: unknown[]) => void;
  } = {},
) {
  const indexPath = join(dir, "index.sqlite");
  const fakeExtensionPath = join(dir, "extension.so");
  const { firstWorkerAutoStart, autoReady = true, ...repositoryOptions } = extra;
  writeFileSync(indexPath, "test-index");
  writeFileSync(fakeExtensionPath, "test-extension");
  return {
    indexPath,
    extensionPath: fakeExtensionPath,
    busyTimeoutMs: 500,
    maxLimit: 10,
    workerFactory: () => {
      const worker = new FakeJapaneseWorker(workers.length > 0 || firstWorkerAutoStart !== false, autoReady);
      workers.push(worker);
      return worker;
    },
    ...repositoryOptions,
  };
}

test("an idle worker failure does not respawn until a new request needs it", async () => {
  const dir = createTempDir("japanese-search-demand-restart-");
  const workers: FakeJapaneseWorker[] = [];
  const repo = JapaneseSearchRepository.open(fakeRepositoryOptions(dir, workers, { restartBaseDelayMs: 5 }));
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    await waitUntil(() => workers.length === 1 && workers[0]!.ready);
    workers[0]!.emit("error", new Error("simulated idle worker failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(workers.length, 1, "an idle failure must not trigger background model reloads");

    const pending = repo.search({ query: "after-failure", mode: "any", limit: 5, offset: 0 });
    await waitUntil(() => workers.length === 2 && workers[1]!.posted.length === 1);
    const id = workers[1]!.posted[0]!.id as number;
    workers[1]!.respond(id);
    assert.deepEqual(await pending, { id });
  } finally {
    clearTimeout(keepAlive);
    repo.close();
    removeTempDir(dir);
  }
});

test("Japanese startup failures use a bounded retry count and exponential backoff", async () => {
  const dir = createTempDir("japanese-search-restart-limit-");
  const workers: FakeJapaneseWorker[] = [];
  const restartSchedules: Array<Record<string, unknown>> = [];
  const repo = JapaneseSearchRepository.open(fakeRepositoryOptions(dir, workers, {
    restartBaseDelayMs: 2,
    restartMaxDelayMs: 5,
    maxRestartAttempts: 2,
    autoReady: false,
    log: (...args) => {
      if (args[0] === "[japanese-search] scheduling worker restart" && args[1] && typeof args[1] === "object") {
        restartSchedules.push(args[1] as Record<string, unknown>);
      }
    },
  }));
  const keepAlive = setTimeout(() => undefined, 1000);
  const requests = ["first", "second", "third"].map((query) =>
    repo.search({ query, mode: "any", limit: 5, offset: 0 }));
  const failures = requests.map((request) => assert.rejects(request, /repeated worker failures/));
  try {
    await waitUntil(() => workers.length === 1);
    workers[0]!.emit("error", new Error("startup failure one"));
    await waitUntil(() => workers.length === 2);
    workers[1]!.emit("error", new Error("startup failure two"));
    await waitUntil(() => workers.length === 3);
    workers[2]!.emit("error", new Error("startup failure three"));
    await Promise.all(failures);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(workers.length, 3, "repeated pre-ready failures must stop further worker creation");
    assert.equal(workers[2]!.terminated, true, "the failed worker must be terminated even when no retry remains");
    assert.deepEqual(restartSchedules.map((schedule) => schedule.delayMs), [2, 4], "restart delay must double and respect the configured cap");
    assert.deepEqual(restartSchedules.map((schedule) => schedule.attempt), [1, 2]);

    await assert.rejects(
      repo.search({ query: "after-limit", mode: "any", limit: 5, offset: 0 }),
      /restart the server/,
      "new demand must not bypass an exhausted startup retry budget",
    );
    assert.equal(workers.length, 3, "the exhausted startup retry budget remains in force for later requests");
  } finally {
    clearTimeout(keepAlive);
    repo.close();
    removeTempDir(dir);
  }
});

test("startup-error is terminal and does not enter the automatic restart loop", async () => {
  const dir = createTempDir("japanese-search-startup-error-");
  const workers: FakeJapaneseWorker[] = [];
  const repo = JapaneseSearchRepository.open(fakeRepositoryOptions(dir, workers, { restartBaseDelayMs: 2 }));
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    const pending = repo.search({ query: "invalid-index", mode: "any", limit: 5, offset: 0 });
    workers[0]!.emit("message", { type: "startup-error", message: "invalid index metadata" });
    await assert.rejects(pending, /unavailable/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(workers.length, 1, "a configuration/index startup error must not be retried");
    assert.equal(workers[0]!.terminated, true);

    await assert.rejects(
      repo.search({ query: "still-invalid", mode: "any", limit: 5, offset: 0 }),
      /unavailable/,
    );
    assert.equal(workers.length, 1);
  } finally {
    clearTimeout(keepAlive);
    repo.close();
    removeTempDir(dir);
  }
});

test("queued Japanese searches expire after the queue-wait deadline", async () => {
  const dir = createTempDir("japanese-search-queue-deadline-");
  const workers: FakeJapaneseWorker[] = [];
  const repo = JapaneseSearchRepository.open(fakeRepositoryOptions(dir, workers, {
    executionTimeoutMs: 500,
    queueWaitTimeoutMs: 25,
  }));
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    const first = repo.search({ query: "active", mode: "any", limit: 5, offset: 0 });
    const second = repo.search({ query: "waiting", mode: "any", limit: 5, offset: 0 });
    const secondFailure = assert.rejects(second, /25 ms queue-wait limit/);
    await waitUntil(() => workers.length === 1 && workers[0]!.posted.length === 1);
    await secondFailure;
    workers[0]!.respond(workers[0]!.posted[0]!.id as number);
    assert.deepEqual(await first, { id: workers[0]!.posted[0]!.id });
    assert.deepEqual(workers[0]!.posted.map((item) => item.query), ["active"]);
  } finally {
    clearTimeout(keepAlive);
    repo.close();
    removeTempDir(dir);
  }
});

test("Japanese search dispatches one request at a time in FIFO order", async () => {
  const dir = createTempDir("japanese-search-queue-");
  const workers: FakeJapaneseWorker[] = [];
  const repo = JapaneseSearchRepository.open(fakeRepositoryOptions(dir, workers));
  const request = (query: string) => ({ query, mode: "any" as const, limit: 5, offset: 0 });
  try {
    const first = repo.search(request("first"));
    const second = repo.search(request("second"));
    const third = repo.search(request("third"));
    const fourth = repo.search(request("fourth"));
    const rejected = repo.search(request("fifth"));
    await assert.rejects(rejected, /busy/);
    await waitUntil(() => workers.length === 1 && workers[0]!.posted.length === 1);
    assert.deepEqual(workers[0]!.posted.map((item) => item.query), ["first"], "queued requests must not be posted to a busy worker");

    const firstId = workers[0]!.posted[0]!.id as number;
    workers[0]!.respond(firstId);
    assert.deepEqual(await first, { id: firstId });
    await waitUntil(() => workers[0]!.posted.length === 2);
    assert.deepEqual(workers[0]!.posted.map((item) => item.query), ["first", "second"]);

    const secondId = workers[0]!.posted[1]!.id as number;
    workers[0]!.respond(secondId);
    assert.deepEqual(await second, { id: secondId });
    await waitUntil(() => workers[0]!.posted.length === 3);
    const thirdId = workers[0]!.posted[2]!.id as number;
    assert.equal(workers[0]!.posted[2]!.query, "third");
    workers[0]!.respond(thirdId);
    assert.deepEqual(await third, { id: thirdId });
    await waitUntil(() => workers[0]!.posted.length === 4);
    const fourthId = workers[0]!.posted[3]!.id as number;
    assert.equal(workers[0]!.posted[3]!.query, "fourth");
    workers[0]!.respond(fourthId);
    assert.deepEqual(await fourth, { id: fourthId });
  } finally {
    repo.close();
    removeTempDir(dir);
  }
});

test("cancelling a queued Japanese search removes it without disturbing the active request", async () => {
  const dir = createTempDir("japanese-search-queue-cancel-");
  const workers: FakeJapaneseWorker[] = [];
  const repo = JapaneseSearchRepository.open(fakeRepositoryOptions(dir, workers));
  const request = (query: string) => ({ query, mode: "any" as const, limit: 5, offset: 0 });
  try {
    const first = repo.search(request("first"));
    const controller = new AbortController();
    const second = repo.search(request("second"), controller.signal);
    await waitUntil(() => workers[0]?.posted.length === 1);
    controller.abort();
    await assert.rejects(second, /cancelled/);
    workers[0]!.respond(workers[0]!.posted[0]!.id as number);
    await first;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(workers[0]!.posted.map((item) => item.query), ["first"]);
  } finally {
    repo.close();
    removeTempDir(dir);
  }
});

test("execution timeouts do not consume the pre-ready worker restart budget", async () => {
  const dir = createTempDir("japanese-search-timeout-retry-budget-");
  const workers: FakeJapaneseWorker[] = [];
  const repo = JapaneseSearchRepository.open(fakeRepositoryOptions(dir, workers, {
    executionTimeoutMs: 8,
    queueWaitTimeoutMs: 1_000,
    restartBaseDelayMs: 1,
    maxRestartAttempts: 1,
  }));
  const keepAlive = setTimeout(() => undefined, 2_000);
  try {
    for (let index = 0; index < 7; index += 1) {
      const pending = repo.search({ query: `slow-${index}`, mode: "any", limit: 5, offset: 0 });
      await waitUntil(() => workers.length === index + 1 && workers[index]!.posted.length === 1);
      await assert.rejects(pending, /execution limit/);
    }
    assert.equal(workers.length, 7, "each healthy Worker boot must restore the retry budget for later slow requests");
  } finally {
    clearTimeout(keepAlive);
    repo.close();
    removeTempDir(dir);
  }
});

test("Japanese execution timeout starts after Worker start and preserves queued requests across restart", async () => {
  const dir = createTempDir("japanese-search-queue-timeout-");
  const workers: FakeJapaneseWorker[] = [];
  const repo = JapaneseSearchRepository.open(fakeRepositoryOptions(dir, workers, { executionTimeoutMs: 25, firstWorkerAutoStart: false }));
  const request = (query: string) => ({ query, mode: "any" as const, limit: 5, offset: 0 });
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    const first = repo.search(request("slow"));
    const second = repo.search(request("queued"));
    await waitUntil(() => workers.length === 1 && workers[0]!.posted.length === 1);
    let firstSettled = false;
    void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(firstSettled, false, "time spent before the worker sends started must not consume the execution timeout");
    workers[0]!.emit("message", { type: "started", id: workers[0]!.posted[0]!.id });
    await assert.rejects(first, /execution limit/);
    await waitUntil(() => workers.length === 2 && workers[1]!.posted.length === 1);
    assert.equal(workers[1]!.posted[0]!.query, "queued", "the queued request must survive the timed-out worker");
    const secondId = workers[1]!.posted[0]!.id as number;
    workers[1]!.respond(secondId);
    assert.deepEqual(await second, { id: secondId });
  } finally {
    clearTimeout(keepAlive);
    repo.close();
    removeTempDir(dir);
  }
});
