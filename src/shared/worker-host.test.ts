import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WorkerHost, type WorkerThreadLike } from "./worker-host.js";

class FakeWorker extends EventEmitter implements WorkerThreadLike {
  terminateCalls = 0;
  refCalls = 0;
  unrefCalls = 0;
  readonly posted: unknown[] = [];

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    queueMicrotask(() => this.emit("exit", 1));
    return Promise.resolve(1);
  }

  ref(): this {
    this.refCalls += 1;
    return this;
  }

  unref(): this {
    this.unrefCalls += 1;
    return this;
  }
}

test("WorkerHost keeps ready promises generation-specific and ignores detached messages", async () => {
  const workers: FakeWorker[] = [];
  let receivedMessages = 0;
  let failures = 0;
  let host!: WorkerHost<{ type: string }, string>;
  host = new WorkerHost({
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    startupTimeoutMs: 1_000,
    onMessage: (generation, message) => {
      if (message.type === "ready") host.resolveReady(generation, `ready-${generation.id}`);
      receivedMessages += 1;
    },
    onFailure: () => { failures += 1; },
  });

  const first = host.start();
  workers[0]!.emit("message", { type: "ready" });
  assert.equal(await first.ready, "ready-1");
  host.ref(first);
  host.unref(first);
  assert.equal(workers[0]!.refCalls, 1);
  assert.equal(workers[0]!.unrefCalls, 1);

  await host.terminate(first);
  const beforeOldMessage = receivedMessages;
  workers[0]!.emit("message", { type: "late" });
  workers[0]!.emit("exit", 0);
  assert.equal(receivedMessages, beforeOldMessage, "a detached generation must not deliver messages");
  assert.equal(failures, 0, "intentional termination must not be reported as a Worker failure");

  const second = host.start();
  assert.notEqual(second.id, first.id);
  workers[0]!.emit("message", { type: "late-after-restart" });
  workers[1]!.emit("message", { type: "ready" });
  assert.equal(await second.ready, "ready-2");
  await host.terminate(second);
});

test("WorkerHost delivers error/exit failure at most once and termination is idempotent", async () => {
  const workers: FakeWorker[] = [];
  const failures: string[] = [];
  const host = new WorkerHost<{ type: string }, void>({
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    startupTimeoutMs: 1_000,
    onMessage: () => undefined,
    onFailure: (_generation, failure) => failures.push(failure.type),
  });

  const generation = host.start();
  workers[0]!.emit("error", new Error("boom"));
  workers[0]!.emit("exit", 1);
  assert.deepEqual(failures, ["error"]);
  assert.equal(host.current, undefined);

  const firstTermination = host.terminate(generation);
  const secondTermination = host.terminate(generation);
  assert.equal(firstTermination, secondTermination);
  await firstTermination;
  assert.equal(workers[0]!.terminateCalls, 1);
});

test("WorkerHost reports startup timeout once and detaches the generation", async () => {
  const workers: FakeWorker[] = [];
  const failures: string[] = [];
  const host = new WorkerHost<{ type: string }, void>({
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    startupTimeoutMs: 5,
    onMessage: () => undefined,
    onFailure: (_generation, failure) => failures.push(failure.type),
  });
  const generation = host.start();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(failures, ["startup-timeout"]);
  assert.equal(host.current, undefined);
  await assert.rejects(generation.ready, /startup exceeded 5 ms/);
  await host.terminate(generation);
  assert.equal(workers[0]!.terminateCalls, 1);
});
