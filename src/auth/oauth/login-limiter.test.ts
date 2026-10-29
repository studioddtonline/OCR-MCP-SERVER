import assert from "node:assert/strict";
import { test } from "node:test";
import { LoginLimiter, LOGIN_WINDOW_MS, type LoginFailureWindow } from "./login-limiter.js";

test("LoginLimiter reuses a live failure window and replaces it at expiry", () => {
  const limiter = new LoginLimiter();
  const first = limiter.getOrCreate("client-a", 1_000);
  first.count = 4;

  assert.strictEqual(limiter.getOrCreate("client-a", 1_001), first);
  assert.equal(limiter.getOrCreate("client-a", 1_001).count, 4);

  const next = limiter.getOrCreate("client-a", first.resetAt);
  assert.notStrictEqual(next, first);
  assert.deepEqual(next, { count: 0, resetAt: first.resetAt + LOGIN_WINDOW_MS });
});

test("LoginLimiter reset removes the client's failed-attempt window", () => {
  const limiter = new LoginLimiter();
  limiter.getOrCreate("client-a", 1_000).count = 5;
  limiter.reset("client-a");
  assert.deepEqual(limiter.getOrCreate("client-a", 1_001), { count: 0, resetAt: 1_001 + LOGIN_WINDOW_MS });
});

test("LoginLimiter prunes expired entries when the map reaches 1,000 entries", () => {
  const limiter = new LoginLimiter();
  const internal = limiter as unknown as { failures: Map<string, LoginFailureWindow> };
  for (let index = 0; index < 1_000; index++) limiter.getOrCreate(`expired-${index}`, 0);
  assert.equal(internal.failures.size, 1_000);

  limiter.getOrCreate("fresh-client", LOGIN_WINDOW_MS + 1);
  assert.equal(internal.failures.size, 1);
  assert.ok(internal.failures.has("fresh-client"));
});
