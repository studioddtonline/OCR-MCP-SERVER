import { createTempDir, removeTempDir } from "../../test/support/temp-dir.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createOcrFixtureDatabase } from "../../test/support/ocr-fixture.js";
import { closeTestServer, waitForTestServer } from "../../test/support/http-server.js";
import { test } from "node:test";
import { bootstrap, describeOcrDatabaseFailure, MINIMUM_SUPPORTED_NODE_VERSION, type BootstrapOptions } from "./bootstrap.js";
import { loadConfig } from "../config/load.js";
import type { AppConfig } from "../config/types.js";
import type { Runtime } from "./runtime.js";
import { TokenStore } from "../auth/token-store.js";
import { SCOPE_WRITE } from "../auth/scopes.js";
import { startHttpServer } from "../http/server.js";
import { createMcpHttpHandler } from "../mcp/http-handler.js";

// index.ts の「どのストアを開き、開けなかったときにどう劣化させるか」の判断を、実ファイル・実サーバーで検証する。
// 方針: 設定の構造ミスは起動前に止める / 環境の問題ではサーバーを止めず劣化 / 認証 DB 障害は MCP を 503 で閉じる /
//       起動時に開けなかった DB は再起動まで復旧しない (意図した仕様)。

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

test("missing SQLite FTS5 startup errors explain the required Node.js version", () => {
  const reason = describeOcrDatabaseFailure(new Error("images_fts cannot be queried with MATCH", {
    cause: new Error("no such module: fts5"),
  }));
  assert.ok(reason.includes(`Node.js >=${MINIMUM_SUPPORTED_NODE_VERSION}`));
  assert.match(reason, /no such module: fts5/);
  assert.ok(!describeOcrDatabaseFailure(new Error("disk I/O error")).includes(`Node.js >=${MINIMUM_SUPPORTED_NODE_VERSION}`));
});

test("Node.js engine, README, and missing-FTS5 diagnostic stay aligned", () => {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { engines?: { node?: string } };
  const packageLock = JSON.parse(readFileSync(join(projectRoot, "package-lock.json"), "utf8")) as { packages?: Record<string, { engines?: { node?: string } }> };
  const readme = readFileSync(join(projectRoot, "README.md"), "utf8");
  assert.equal(packageJson.engines?.node, `>=${MINIMUM_SUPPORTED_NODE_VERSION}`);
  assert.equal(packageLock.packages?.[""]?.engines?.node, `>=${MINIMUM_SUPPORTED_NODE_VERSION}`);
  assert.ok(readme.includes(`Node.js ${MINIMUM_SUPPORTED_NODE_VERSION}`));
  assert.ok(readme.includes(`${MINIMUM_SUPPORTED_NODE_VERSION} 以降`));
});

test("bootstrap logs the actionable FTS5 runtime guidance when DB opening fails", async () => {
  await withEnv(async (env) => {
    env.logs.length = 0;
    const { stop } = await env.start(env.config(), {
      openDatabase: () => {
        throw new Error("images_fts cannot be queried with MATCH", { cause: new Error("no such module: fts5") });
      },
    });
    assert.ok(env.logs.some((line) => line.includes("OCR database unavailable") && line.includes(`Node.js >=${MINIMUM_SUPPORTED_NODE_VERSION}`) && line.includes("no such module: fts5")), env.logs.join(" | "));
    await stop();
  });
});

function makeOcrDb(path: string) {
  createOcrFixtureDatabase(path).close();
}

interface Env {
  dir: string;
  logs: string[];
  log: (...args: unknown[]) => void;
  config(overrides?: Partial<AppConfig> & { dataDir?: string }): AppConfig;
  start(config: AppConfig, bootstrapOptions?: BootstrapOptions): Promise<{ base: string; runtime: Runtime; stop(): Promise<void> }>;
}

async function withEnv(run: (env: Env) => Promise<void>) {
  const dir = createTempDir("bootstrap-test-");
  const logs: string[] = [];
  const log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  const stops: Array<() => Promise<void>> = [];
  makeOcrDb(join(dir, "ocr.sqlite"));
  const env: Env = {
    dir, logs, log,
    config: (overrides = {}) => ({
      server: { host: "127.0.0.1", port: 0, publicBaseUrl: "https://ddns.s13e.net", mcpPath: "/mcp", allowedHosts: ["127.0.0.1", "ddns.s13e.net"] },
      auth: { mode: "none" },
      database: { path: join(dir, "ocr.sqlite"), busyTimeoutMs: 5000 },
      search: { defaultLimit: 20, maxLimit: 50, snippetLength: 160 },
      ...overrides,
    }),
    async start(config, bootstrapOptions = {}) {
      const runtime = bootstrap(config, { ...bootstrapOptions, log, logError: log });
      const server = startHttpServer(config, createMcpHttpHandler({ ...runtime, ocrWrite: { ...runtime.ocrWrite, log } }, config), runtime.oauth);
      const { base } = await waitForTestServer(server);
      const stop = async () => {
        await closeTestServer(server);
        runtime.close();
      };
      stops.push(stop);
      return { base, runtime, stop };
    },
  };
  try {
    await run(env);
  } finally {
    for (const stop of stops.reverse()) await stop().catch(() => undefined);
    removeTempDir(dir);
  }
}

const oauthConfig = (env: Env, over: { oauthPath?: string; tokensPath?: string } = {}): AppConfig => env.config({
  auth: { mode: "oauth" },
  oauth: { databasePath: over.oauthPath ?? join(env.dir, "data", "oauth.sqlite"), allowedRedirectUris: ["https://claude.ai/api/mcp/auth_callback"], cimdAllowedHosts: ["claude.ai"] },
  staticTokens: { databasePath: over.tokensPath ?? join(env.dir, "data", "tokens.sqlite") },
});

const rpc = (base: string, body: unknown, bearer?: string) =>
  fetch(`${base}/mcp`, { method: "POST", headers: { ...HEADERS, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
const callTool = (base: string, name: string, args: unknown = {}, bearer?: string) =>
  rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, bearer);
/** SSE (event: message / data: {...}) 形式の応答から JSON-RPC の result を取り出す。 */
async function toolResult(res: Response): Promise<{ isError?: boolean; text: string }> {
  const raw = await res.text();
  const data = raw.split("\n").find((l) => l.startsWith("data: ")) ?? `data: ${raw}`;
  const result = (JSON.parse(data.slice(6)) as { result: { isError?: boolean; content: Array<{ type: string; text?: string }> } }).result;
  return { isError: result.isError, text: result.content.map((c) => c.text ?? "").join("\n") };
}

test("healthy start (auth none): OCR DB opens, no OAuth stores, unconfigured image storage is only logged", async () => {
  await withEnv(async (env) => {
    const { base, runtime } = await env.start(env.config());
    await runtime.originalImagesChecked;
    assert.equal(runtime.oauth, undefined);
    assert.ok(env.logs.some((l) => l.includes("OCR database opened")));
    assert.ok(env.logs.some((l) => l.includes("original image storage unavailable") && l.includes("not configured")));
    const stats = await toolResult(await callTool(base, "get_ocr_stats"));
    assert.equal(stats.isError, undefined);
    assert.match(stats.text, /"total":\s*2/);
    runtime.close();
    assert.throws(() => runtime.repo.getStats(), "the OCR database is closed by close()");
  });
});

test("OCR DB missing / a directory / not a SQLite file: server still starts; tools fail with a fixed message and no local path", async () => {
  await withEnv(async (env) => {
    mkdirSync(join(env.dir, "a-directory"));
    writeFileSync(join(env.dir, "not-sqlite"), "this is not a database");
    for (const path of [join(env.dir, "missing", "ocr.sqlite"), join(env.dir, "a-directory"), join(env.dir, "not-sqlite")]) {
      env.logs.length = 0;
      const { base, runtime, stop } = await env.start({ ...env.config(), database: { path, busyTimeoutMs: 5000 } });
      assert.ok(env.logs.some((l) => l.includes("OCR database unavailable") && l.includes(path)), `the startup log names the failing config path for ${path}`);

      // tools/list は生きている (接続全体は失敗扱いにならない)
      const listed = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      assert.equal(listed.status, 200);
      assert.match(await listed.text(), /get_ocr_stats/);

      for (const [tool, args] of [["get_ocr_stats", {}], ["search_ocr", { query: "sample" }], ["get_ocr_record", { id: 1 }], ["list_source_labels", {}]] as const) {
        const res = await callTool(base, tool, args);
        assert.equal(res.status, 200, "tool-level error, not an HTTP failure");
        const out = await toolResult(res);
        assert.equal(out.isError, true, tool);
        assert.match(out.text, /OCR database is unavailable/);
        assert.ok(!out.text.includes(env.dir), `${tool}: the local path must not reach the client: ${out.text}`);
        assert.ok(!/ENOENT|unable to open|SQLITE|not a database/i.test(out.text), `${tool}: no driver details: ${out.text}`);
      }
      await stop();
    }
  });
});

test("schema mismatch is caught at startup (not at the first tool call): degraded start, operator log names the columns, client sees only a fixed message", async () => {
  await withEnv(async (env) => {
    const cases: Array<[string, string, RegExp]> = [
      ["missing columns", `CREATE TABLE source_images (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT); CREATE VIRTUAL TABLE images_fts USING fts5(ocr_text);`, /missing required column\(s\): ocr_text, reviewed/],
      ["images_fts is a plain table", `CREATE TABLE source_images (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, ocr_text TEXT, reviewed INTEGER); CREATE TABLE images_fts (x TEXT);`, /must be an FTS5 virtual table/],
    ];
    for (const [name, sql, expectedLog] of cases) {
      const path = join(env.dir, `${name.replace(/\W+/g, "_")}.sqlite`);
      const db = new DatabaseSync(path); db.exec(sql); db.close();
      env.logs.length = 0;
      const { base, stop } = await env.start({ ...env.config(), database: { path, busyTimeoutMs: 5000 } });
      assert.ok(!env.logs.some((l) => l.includes("OCR database opened and schema validated")), `${name}: must NOT claim the schema was validated`);
      assert.ok(env.logs.some((l) => l.includes("OCR database unavailable") && expectedLog.test(l) && l.includes(path)), `${name}: ${env.logs.join(" | ")}`);
      const out = await toolResult(await callTool(base, "get_ocr_stats"));
      assert.equal(out.isError, true, name);
      assert.deepEqual(JSON.parse(out.text), { error: "OCR database is unavailable" }, `${name}: the client gets no schema details`);
      await stop();
    }
  });
});

test("original image storage problems reach the client only as fixed messages", async () => {
  await withEnv(async (env) => {
    const missingRoot = join(env.dir, "unmounted-books");
    const { base, runtime } = await env.start({ ...env.config(), originalImages: { rootPath: missingRoot } });
    await runtime.originalImagesChecked; // 起動時チェックは reject せず、ログに出すだけ
    assert.ok(env.logs.some((l) => l.includes("original image storage unavailable") && l.includes(missingRoot)), "operator log keeps the path");
    for (const [tool, args] of [["list_original_book_directories", {}], ["list_original_images", { bookDirectory: "BookA" }], ["get_original_image", { bookDirectory: "BookA", fileName: "1.png" }]] as const) {
      const out = await toolResult(await callTool(base, tool, args));
      assert.equal(out.isError, true, tool);
      assert.match(out.text, /Original image storage is unavailable/);
      assert.ok(!out.text.includes(missingRoot) && !out.text.includes(env.dir) && !/ENOENT|realpath/.test(out.text), `${tool}: ${out.text}`);
    }
  });
});


test("OCR write repository startup failure keeps read-only tools available and returns write_unavailable", async () => {
  await withEnv(async (env) => {
    const config: AppConfig = { ...oauthConfig(env), ocrWrite: { enabled: true } };
    const { base, runtime } = await env.start(config, {
      openWriteRepository: () => { throw new Error("simulated write database failure"); },
    });
    assert.equal(runtime.ocrWrite.enabled, true);
    assert.equal(runtime.ocrWrite.repository, undefined);
    assert.ok(env.logs.some((line) => line.includes("OCR write repository unavailable") && line.includes("simulated write database failure")));

    assert.ok(runtime.oauth?.status === "ready");
    const token = runtime.oauth.tokens.create({ name: "write-fallback", purpose: "api", scopes: [SCOPE_WRITE] }).token;
    const readResult = await toolResult(await callTool(base, "get_ocr_stats", {}, token));
    assert.equal(readResult.isError, undefined, "read-only tools remain available");
    const writeResult = await toolResult(await callTool(base, "update_ocr_text", { id: 2, newText: "must not be written" }, token));
    assert.equal(writeResult.isError, true);
    assert.deepEqual(JSON.parse(writeResult.text), {
      code: "write_unavailable", error: "OCR writing is unavailable on this server instance.",
    });
  });
});

test("oauth mode, healthy: stores open, a CLI-issued static token works against the running server, close() releases the DBs", async () => {
  await withEnv(async (env) => {
    const config = oauthConfig(env);
    const { base, runtime } = await env.start(config);
    assert.ok(runtime.oauth && runtime.oauth.status === "ready");

    // CLI と同じ手順 (別の TokenStore インスタンスから発行) で作ったトークンを、稼働中のサーバーが受け付ける
    const cli = new TokenStore(config.staticTokens!.databasePath);
    const apiToken = cli.create({ name: "claude-code", purpose: "api" }).token;
    cli.close();
    assert.equal((await callTool(base, "get_ocr_stats")).status, 401);
    const ok = await callTool(base, "get_ocr_stats", {}, apiToken);
    assert.equal(ok.status, 200);
    assert.match((await toolResult(ok)).text, /"total":\s*2/);

    runtime.close();
    assert.throws(() => (runtime.oauth && runtime.oauth.status === "ready" ? runtime.oauth.store : assert.fail("OAuth store should be available")).getClient("x"), "OAuth DB closed");
    assert.throws(() => (runtime.oauth && runtime.oauth.status === "ready" ? runtime.oauth.tokens : assert.fail("token store should be available")).list(), "token DB closed");
  });
});

for (const broken of ["tokens", "oauth"] as const) {
  test(`oauth mode, ${broken} DB cannot be opened: starts, MCP/OAuth are 503 (never open), discovery stays up, and only a restart recovers`, async () => {
    await withEnv(async (env) => {
      // 親ディレクトリが通常ファイルなので mkdir できない → ストアを開けない
      const blocker = join(env.dir, "blocker");
      writeFileSync(blocker, "x");
      const config = broken === "tokens"
        ? oauthConfig(env, { tokensPath: join(blocker, "tokens.sqlite") })
        : oauthConfig(env, { oauthPath: join(blocker, "oauth.sqlite") });
      const { base, runtime, stop } = await env.start(config);
      assert.ok(runtime.oauth && runtime.oauth.status === "unavailable", "the reason is recorded");
      assert.ok(runtime.oauth.unavailableReason);
      assert.ok(env.logs.some((l) => l.includes("database unavailable") && l.includes(blocker)), "operator log has the path");

      // 認証なしでも、でたらめなトークンでも 503 (無認証で通らない)
      for (const bearer of [undefined, "ocrmcp_api_" + "x".repeat(43), "garbage"]) {
        const res = await callTool(base, "get_ocr_stats", {}, bearer);
        assert.equal(res.status, 503, String(bearer));
        const body = await res.text();
        assert.ok(!body.includes(env.dir) && !/ENOENT|EEXIST|ENOTDIR|mkdir/.test(body), `503 body must be generic: ${body}`);
      }
      const post = (path: string, init: RequestInit) => fetch(`${base}${path}`, init);
      assert.equal((await post("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token" })).status, 503);
      assert.equal((await post("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "c", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) })).status, 503);
      assert.equal((await post("/.well-known/oauth-authorization-server", {})).status, 200, "static discovery metadata stays available");

      // 原因を取り除いても、起動時に開けなかった DB は再起動まで復旧しない (仕様)
      unlinkSync(blocker);
      assert.equal((await callTool(base, "get_ocr_stats")).status, 503);

      // 再起動 (= 新しい bootstrap) すれば復旧する: 認証ゲートが有効になり、トークンなしは 401
      await stop();
      const restarted = await env.start(config);
      assert.ok(restarted.runtime.oauth && restarted.runtime.oauth.status === "ready");
      assert.equal((await callTool(restarted.base, "get_ocr_stats")).status, 401);
    });
  });
}

test("oauth mode with the DB paths missing from the config object degrades instead of crashing the process", async () => {
  await withEnv(async (env) => {
    const config: AppConfig = { ...env.config(), auth: { mode: "oauth" } }; // oauth / staticTokens セクションなし (loadConfig を迂回)
    const { base, runtime } = await env.start(config);
    assert.match((runtime.oauth?.status === "unavailable" ? runtime.oauth.unavailableReason : ""), /oauth\.databasePath is not configured/);
    assert.match((runtime.oauth?.status === "unavailable" ? runtime.oauth.unavailableReason : ""), /staticTokens\.databasePath is not configured/);
    assert.equal((await callTool(base, "get_ocr_stats")).status, 503);
  });
});

test("config file -> loadConfig -> bootstrap -> server: the whole startup path works from a real config file", async () => {
  await withEnv(async (env) => {
    const configPath = join(env.dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      server: { host: "127.0.0.1", port: 3001, publicBaseUrl: "https://ddns.s13e.net", allowedHosts: ["127.0.0.1"] },
      auth: { mode: "oauth" },
      oauth: { databasePath: join(env.dir, "oauth.sqlite") },
      staticTokens: { databasePath: join(env.dir, "tokens.sqlite") },
      database: { path: join(env.dir, "ocr.sqlite") },
    }));
    const previous = process.env.MCP_CONFIG_PATH;
    process.env.MCP_CONFIG_PATH = configPath;
    let config: AppConfig;
    try { config = loadConfig(); } finally {
      if (previous === undefined) delete process.env.MCP_CONFIG_PATH; else process.env.MCP_CONFIG_PATH = previous;
    }
    config.server.port = 0; // 実ポートの代わりに空きポートを使う
    const { base } = await env.start(config);
    const cli = new TokenStore(config.staticTokens!.databasePath);
    const apiToken = cli.create({ name: "e2e", purpose: "api" }).token;
    cli.close();
    assert.equal((await toolResult(await callTool(base, "get_ocr_stats", {}, apiToken))).isError, undefined);
    assert.equal((await callTool(base, "get_ocr_stats")).status, 401);
  });
});
