import type { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { Runtime } from "./app/runtime.js";

export const DEFAULT_SHUTDOWN_GRACE_PERIOD_MS = 10_000;

export interface ShutdownOptions {
  /** Maximum time to wait for active HTTP connections after the first signal. */
  gracePeriodMs?: number;
  /** Injectable for deterministic tests; production uses process.exit. */
  exit?: (code: number) => void;
  /** Injectable for tests; production uses process. */
  signals?: EventEmitter;
}

/**
 * Install SIGINT/SIGTERM handling for the HTTP server and its runtime resources.
 *
 * The first signal starts graceful shutdown. A second signal, or expiration of
 * the grace period, forces remaining HTTP connections closed and exits nonzero.
 */
export function installShutdownHandlers(
  server: Server,
  runtime: Pick<Runtime, "close">,
  options: ShutdownOptions = {},
): void {
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_SHUTDOWN_GRACE_PERIOD_MS;
  if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
    throw new RangeError("gracePeriodMs must be a non-negative finite number");
  }

  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let state: "running" | "shutting-down" | "forced" | "closed" = "running";
  let timer: NodeJS.Timeout | undefined;
  let runtimeClosed = false;

  const closeRuntime = (): void => {
    if (runtimeClosed) return;
    runtimeClosed = true;
    runtime.close();
  };

  const forceShutdown = (): void => {
    if (state === "forced" || state === "closed") return;
    state = "forced";
    if (timer) clearTimeout(timer);
    server.closeAllConnections();
    closeRuntime();
    exit(1);
  };

  const shutdown = (): void => {
    if (state !== "running") {
      if (state === "shutting-down") forceShutdown();
      return;
    }

    state = "shutting-down";
    timer = setTimeout(forceShutdown, gracePeriodMs);
    timer.unref();

    try {
      server.close((error) => {
        if (state !== "shutting-down") return;
        if (timer) clearTimeout(timer);
        state = "closed";
        closeRuntime();
        exit(error ? 1 : 0);
      });
      // close() stops accepting new connections. Close idle keep-alive sockets
      // explicitly rather than making graceful shutdown wait for their timeout.
      server.closeIdleConnections();
    } catch {
      forceShutdown();
    }
  };

  signals.on("SIGINT", shutdown);
  signals.on("SIGTERM", shutdown);
}
