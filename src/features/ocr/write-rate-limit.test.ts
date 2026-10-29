import assert from "node:assert/strict";
import { test } from "node:test";
import { OcrWriteRateLimiter } from "./write-rate-limit.js";

test("write limiter allows ten writes per client in a rolling minute and reports retry delay", () => {
  const limiter = new OcrWriteRateLimiter();
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.consume("client-a", 1_000 + i).allowed, true);
  assert.deepEqual(limiter.consume("client-a", 1_010), {
    allowed: false, rejectedBy: "client", retryAfterSeconds: 60,
  });
  assert.equal(limiter.consume("client-a", 61_001).allowed, true);
});

test("write limiter applies the thirty-write server-wide limit across clients", () => {
  const limiter = new OcrWriteRateLimiter();
  for (let i = 0; i < 30; i += 1) assert.equal(limiter.consume(`client-${i}`, 5_000 + i).allowed, true);
  const blocked = limiter.consume("another-client", 5_030);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) {
    assert.equal(blocked.rejectedBy, "server");
    assert.equal(blocked.retryAfterSeconds, 60);
  }
});

test("operational rate-limit logs can be throttled to one per key per minute", () => {
  const limiter = new OcrWriteRateLimiter();
  assert.equal(limiter.shouldLog("server", 100), true);
  assert.equal(limiter.shouldLog("server", 101), false);
  assert.equal(limiter.shouldLog("server", 60_100), true);
});
