import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { Agent, get } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { installShutdownHandlers } from "./shutdown.js";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function waitForExit(): { promise: Promise<number>; exit: (code: number) => void } {
  let resolve!: (code: number) => void;
  const promise = new Promise<number>((done) => { resolve = done; });
  return { promise, exit: resolve };
}

test("graceful shutdown closes idle keep-alive connections and exits zero", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  const signals = new EventEmitter();
  const result = waitForExit();
  let closeCalls = 0;
  const base = await listen(server);
  const agent = new Agent({ keepAlive: true });

  try {
    await new Promise<void>((resolve, reject) => {
      get(base, { agent }, (response) => {
        response.resume();
        response.once("end", resolve);
      }).once("error", reject);
    });

    installShutdownHandlers(server, { close: () => { closeCalls += 1; } }, {
      signals,
      exit: result.exit,
      gracePeriodMs: 100,
    });
    signals.emit("SIGINT");

    assert.equal(await result.promise, 0);
    assert.equal(closeCalls, 1);
  } finally {
    agent.destroy();
    server.closeAllConnections();
  }
});

test("grace-period expiry force-closes an active HTTP connection", async () => {
  const server = createServer(() => { /* Keep the request active until shutdown. */ });
  const signals = new EventEmitter();
  const result = waitForExit();
  let closeCalls = 0;
  const base = await listen(server);

  const requestSeen = once(server, "request");
  const request = get(base);
  await requestSeen;

  try {
    installShutdownHandlers(server, { close: () => { closeCalls += 1; } }, {
      signals,
      exit: result.exit,
      gracePeriodMs: 20,
    });
    signals.emit("SIGINT");

    assert.equal(await result.promise, 1);
    assert.equal(closeCalls, 1);
  } finally {
    request.destroy();
    server.closeAllConnections();
  }
});

test("a second termination signal forces shutdown immediately and closes runtime once", async () => {
  const server = createServer(() => { /* Keep the request active until shutdown. */ });
  const signals = new EventEmitter();
  const result = waitForExit();
  let closeCalls = 0;
  const base = await listen(server);
  const requestSeen = once(server, "request");
  const request = get(base);
  await requestSeen;

  try {
    installShutdownHandlers(server, { close: () => { closeCalls += 1; } }, {
      signals,
      exit: result.exit,
      gracePeriodMs: 10_000,
    });
    signals.emit("SIGTERM");
    signals.emit("SIGINT");

    assert.equal(await result.promise, 1);
    assert.equal(closeCalls, 1);
  } finally {
    request.destroy();
    server.closeAllConnections();
  }
});
