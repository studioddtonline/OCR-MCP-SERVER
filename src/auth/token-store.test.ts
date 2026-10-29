import { createTempDir, removeTempDir } from "../../test/support/temp-dir.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TOKEN_PREFIX, TokenStore } from "./token-store.js";

function withStore(run: (store: TokenStore, path: string) => void) {
  const dir = createTempDir("token-store-test-");
  const path = join(dir, "sub", "tokens.sqlite");
  const store = new TokenStore(path);
  try { run(store, path); } finally { store.close(); removeTempDir(dir); }
}

test("tokens are stored only as hashes, with owner-only file permissions", () => {
  withStore((store, path) => {
    const { token } = store.create({ name: "claude-code", purpose: "api" });
    assert.ok(token.startsWith(TOKEN_PREFIX.api));
    const rows = store.db.prepare("SELECT * FROM static_tokens").all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(token), "plaintext token must not be stored");
    assert.equal(rows[0]!.token_hash, createHash("sha256").update(token).digest("hex"));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
    assert.ok(!JSON.stringify(store.list()).includes(token), "list() never exposes tokens or hashes");
  });
});

test("purposes are separate: an api token is not a login token and vice versa", () => {
  withStore((store) => {
    const api = store.create({ name: "a", purpose: "api" }).token;
    const login = store.create({ name: "l", purpose: "login" }).token;
    assert.equal(store.verify(api, "api")?.name, "a");
    assert.equal(store.verify(login, "login")?.name, "l");
    assert.equal(store.verify(api, "login"), undefined);
    assert.equal(store.verify(login, "api"), undefined);
    // 接頭辞を偽装しても、ハッシュと用途が一致しなければ通らない
    assert.equal(store.verify(`${TOKEN_PREFIX.api}${"x".repeat(43)}`, "api"), undefined);
    assert.equal(store.verify("", "api"), undefined);
    assert.equal(store.verify("x".repeat(1000), "api"), undefined);
  });
});

test("scopes: api tokens always include ocr:read, extra scopes are explicit, unknown scopes and login scopes are rejected", () => {
  withStore((store) => {
    assert.deepEqual(store.verify(store.create({ name: "r", purpose: "api" }).token, "api")?.scopes, ["ocr:read"]);
    assert.deepEqual(store.verify(store.create({ name: "w", purpose: "api", scopes: ["ocr:write"] }).token, "api")?.scopes, ["ocr:read", "ocr:write"]);
    assert.throws(() => store.create({ name: "x", purpose: "api", scopes: ["admin"] }), /Unknown scope/);
    assert.throws(() => store.create({ name: "y", purpose: "login", scopes: ["ocr:read"] }), /cannot have scopes/);
    assert.deepEqual(store.verify(store.create({ name: "l", purpose: "login" }).token, "login")?.scopes, []);
  });
});

test("revoke, expiry, and name reuse for rotation", () => {
  withStore((store) => {
    const first = store.create({ name: "cursor", purpose: "api" }).token;
    assert.throws(() => store.create({ name: "cursor", purpose: "api" }), /already exists/);
    assert.equal(store.revoke("cursor"), true);
    assert.equal(store.revoke("cursor"), false);
    assert.equal(store.verify(first, "api"), undefined);
    const second = store.create({ name: "cursor", purpose: "api" }).token; // ローテーション
    assert.notEqual(second, first);
    assert.equal(store.verify(second, "api")?.name, "cursor");
    assert.equal(store.verify(first, "api"), undefined, "the old token stays revoked");

    const temp = store.create({ name: "temp", purpose: "api", expiresInDays: 1 }).token;
    assert.ok(store.verify(temp, "api")?.expiresAt);
    store.db.prepare("UPDATE static_tokens SET expires_at = ? WHERE name = 'temp'").run(Math.floor(Date.now() / 1000) - 5);
    assert.equal(store.verify(temp, "api"), undefined);
    assert.equal(store.list().find((r) => r.name === "temp")?.status, "expired");
    assert.equal(store.list().find((r) => r.name === "cursor" && r.status === "revoked")?.purpose, "api");
  });
});

test("name and expiry validation", () => {
  withStore((store) => {
    for (const name of ["", " a", "a b", "a/b", "x".repeat(65), "-start"]) {
      assert.throws(() => store.create({ name, purpose: "api" }), /Invalid token name/, JSON.stringify(name));
    }
    for (const days of [0, -1, Number.NaN, 99999]) {
      assert.throws(() => store.create({ name: "e", purpose: "api", expiresInDays: days }), /Invalid expiry/);
    }
  });
});

test("last_used_at is recorded but throttled to one write per minute", () => {
  withStore((store) => {
    const { token } = store.create({ name: "t", purpose: "api" });
    const lastUsed = () => (store.db.prepare("SELECT last_used_at AS v FROM static_tokens WHERE name = 't'").get() as { v: number | null }).v;
    assert.equal(lastUsed(), null);
    store.verify(token, "api");
    const first = lastUsed();
    assert.ok(first);
    store.db.prepare("UPDATE static_tokens SET last_used_at = ? WHERE name = 't'").run(first! - 10);
    store.verify(token, "api");
    assert.equal(lastUsed(), first! - 10, "within the throttle window the row is not rewritten");
    store.db.prepare("UPDATE static_tokens SET last_used_at = ? WHERE name = 't'").run(first! - 120);
    store.verify(token, "api");
    assert.ok(lastUsed()! >= first!, "after the window it is refreshed");
  });
});

test("a recently verified token does not wait for another connection's write lock", () => {
  withStore((store, path) => {
    const { token } = store.create({ name: "recent", purpose: "api" });
    assert.equal(store.verify(token, "api")?.name, "recent"); // Initializes last_used_at.

    const blocker = new DatabaseSync(path, { timeout: 0 });
    blocker.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    try {
      assert.equal(store.verify(token, "api")?.name, "recent");
      assert.ok(performance.now() - started < 1000, "verification in the throttle window should not wait for a write lock");
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });
});

test("failure to record last_used_at does not reject a valid token and backs off repeated write attempts", () => {
  withStore((store) => {
    const { token } = store.create({ name: "telemetry-failure", purpose: "api" });
    let updateAttempts = 0;
    store.db.function("count_last_used_update_attempt", () => { updateAttempts++; return 0; });
    store.db.exec(`
      CREATE TRIGGER reject_last_used_update
      BEFORE UPDATE OF last_used_at ON static_tokens
      BEGIN
        SELECT count_last_used_update_attempt();
        SELECT RAISE(ABORT, 'simulated last_used_at write failure');
      END;
    `);
    const originalError = console.error;
    const logs: string[] = [];
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      assert.equal(store.verify(token, "api")?.name, "telemetry-failure");
      assert.equal(updateAttempts, 1, "the first stale last_used_at attempts one write");
      assert.equal(store.verify(token, "api")?.name, "telemetry-failure", "telemetry failure does not invalidate the token");
      assert.equal(updateAttempts, 1, "subsequent verification does not retry the failed write during backoff");
    } finally {
      console.error = originalError;
    }
    assert.equal(logs.filter((line) => line.includes("last_used_at") && line.includes("simulated last_used_at write failure")).length, 1);
  });
});
