import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientSafeError, clientMessage, describeForLog, errnoCode, isNotFoundError } from "./shared/errors.js";

test("clientMessage passes only ClientSafeError messages and replaces everything else", () => {
  assert.equal(clientMessage(new ClientSafeError("fine to show"), "generic"), "fine to show");
  assert.equal(clientMessage(new Error("ENOENT: no such file or directory, realpath '/mnt/secret'"), "generic"), "generic");
  assert.equal(clientMessage("a string", "generic"), "generic");
  assert.equal(clientMessage(undefined, "generic"), "generic");
  // サブクラスやラップでも自動では通らない (許可リスト方式)
  assert.equal(clientMessage(new Error("wrapper", { cause: new ClientSafeError("inner") }), "generic"), "generic");
});

test("describeForLog includes the cause chain and survives non-errors and cycles", () => {
  const root = new Error("ENOENT: realpath '/mnt/original-books'");
  const top = new ClientSafeError("Original image storage is unavailable", { cause: root });
  assert.equal(describeForLog(top), "Original image storage is unavailable <- ENOENT: realpath '/mnt/original-books'");
  assert.equal(describeForLog("plain"), "plain");
  const a = new Error("a"); const b = new Error("b", { cause: a }); (a as { cause?: unknown }).cause = b;
  assert.ok(describeForLog(a).split(" <- ").length <= 5, "bounded depth even with a cause cycle");
});

test("errno helpers", () => {
  assert.equal(errnoCode(Object.assign(new Error("x"), { code: "EACCES" })), "EACCES");
  assert.equal(errnoCode(new Error("x")), undefined);
  assert.equal(errnoCode(null), undefined);
  assert.equal(isNotFoundError(Object.assign(new Error("x"), { code: "ENOENT" })), true);
  assert.equal(isNotFoundError(Object.assign(new Error("x"), { code: "ENOTDIR" })), true);
  assert.equal(isNotFoundError(Object.assign(new Error("x"), { code: "EACCES" })), false);
});
