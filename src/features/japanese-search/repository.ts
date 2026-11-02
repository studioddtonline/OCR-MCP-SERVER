import { accessSync, constants } from "node:fs";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { ClientSafeError } from "../../shared/errors.js";
import { WorkerHost, type WorkerGeneration, type WorkerHostFailure, type WorkerThreadLike } from "../../shared/worker-host.js";

export interface JapaneseSearchOptions {
  indexPath: string;
  extensionPath: string;
  busyTimeoutMs: number;
  maxLimit: number;
  log?: (...args: unknown[]) => void;
  /** Internal test seams; production uses the defaults. */
  workerFactory?: (url: URL, options: WorkerOptions) => WorkerThreadLike;
  executionTimeoutMs?: number;
  startupTimeoutMs?: number;
  /** Internal test seams; production queue/restart limits use the defaults below. */
  queueWaitTimeoutMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  maxRestartAttempts?: number;
}

export interface JapaneseSearchRequest {
  query: string;
  mode: "any" | "all";
  label?: string;
  reviewed?: boolean;
  limit: number;
  offset: number;
}

interface WorkerMetadata {
  schema_version: number;
  tokenizer: string;
  indexed_at: string;
  source_record_count: number;
  source_max_id: number;
}

interface QueuedSearch {
  id: number;
  request: JapaneseSearchRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timeout?: NodeJS.Timeout;
  queueTimeout?: NodeJS.Timeout;
  settled: boolean;
}

type WorkerMessage =
  | { type: "ready"; metadata: WorkerMetadata }
  | { type: "startup-error"; message: string }
  | { type: "started"; id: number }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; code: string; operatorMessage?: string };

const MAX_PENDING_REQUESTS = 4;
const DEFAULT_EXECUTION_TIMEOUT_MS = 20_000;
// Vaporetto model initialization can be expensive on low-power hosts; keep it off the main thread.
const DEFAULT_WORKER_STARTUP_TIMEOUT_MS = 180_000;
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 180_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 250;
const DEFAULT_RESTART_MAX_DELAY_MS = 8_000;
const DEFAULT_MAX_RESTART_ATTEMPTS = 5;

/**
 * Worker-backed reader for the separate sqlite-vaporetto index.
 * Requests are dispatched one at a time. Queue wait does not consume the execution timeout,
 * is capped at three minutes, and failed workers restart only for queued demand with bounded backoff.
 */
export class JapaneseSearchRepository {
  private readonly workerHost: WorkerHost<WorkerMessage, WorkerMetadata>;
  private readonly queue: QueuedSearch[] = [];
  private active: QueuedSearch | undefined;
  private nextId = 1;
  private restartPromise: Promise<void> | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private restartAttempts = 0;
  private restartPendingForStartupFailure = false;
  private pumping = false;
  private closed = false;
  private startupFailed = false;

  private constructor(private readonly options: JapaneseSearchOptions) {
    const factory: (url: URL, workerOptions: WorkerOptions) => WorkerThreadLike =
      options.workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions));
    this.workerHost = new WorkerHost<WorkerMessage, WorkerMetadata>({
      workerFactory: () => factory(new URL("./worker.mjs", import.meta.url), {
        workerData: {
          indexPath: options.indexPath,
          extensionPath: options.extensionPath,
          busyTimeoutMs: options.busyTimeoutMs,
        },
      }),
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_WORKER_STARTUP_TIMEOUT_MS,
      onMessage: (generation, message) => this.onMessage(message, generation),
      onFailure: (generation, failure) => this.onWorkerFailure(failure, generation),
    });
    this.startWorker();
  }

  /** Check the configured files cheaply; the native extension and index are initialized and validated in the worker. */
  static open(options: JapaneseSearchOptions): JapaneseSearchRepository {
    accessSync(options.indexPath, constants.R_OK);
    accessSync(options.extensionPath, constants.R_OK);
    return new JapaneseSearchRepository(options);
  }

  search(request: JapaneseSearchRequest, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new ClientSafeError("Japanese search is unavailable."));
    if (signal?.aborted) return Promise.reject(new ClientSafeError("Japanese search was cancelled."));
    if (this.queue.length + (this.active ? 1 : 0) >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new ClientSafeError("Japanese search is busy; retry after current searches finish."));
    }

    return new Promise((resolve, reject) => {
      const entry: QueuedSearch = {
        id: this.nextId++, request, resolve, reject, signal, settled: false,
      };
      const queueWaitTimeoutMs = this.options.queueWaitTimeoutMs ?? DEFAULT_QUEUE_WAIT_TIMEOUT_MS;
      entry.queueTimeout = setTimeout(() => this.onQueueWaitTimeout(entry, queueWaitTimeoutMs), queueWaitTimeoutMs);
      entry.queueTimeout.unref();
      if (signal) {
        entry.abortListener = () => this.cancel(entry);
        signal.addEventListener("abort", entry.abortListener, { once: true });
      }
      this.queue.push(entry);
      this.pump();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearRestartTimer();
    if (this.active) this.finishEntry(this.active, undefined, new ClientSafeError("Japanese search is unavailable."));
    for (const entry of this.queue.splice(0)) {
      this.finishEntry(entry, undefined, new ClientSafeError("Japanese search is unavailable."));
    }
    const generation = this.workerHost.current;
    this.active = undefined;
    if (generation) {
      void this.workerHost.terminate(generation, new ClientSafeError("Japanese search is unavailable.")).catch((error) => {
        this.options.log?.("[japanese-search] worker termination failed:", error);
      });
    }
  }

  private startWorker(): void {
    if (this.closed) return;
    this.workerHost.start();
  }

  private pump(): void {
    if (this.pumping || this.active || this.closed || this.queue.length === 0) return;
    if (this.startupFailed) {
      this.failQueued(new ClientSafeError("Japanese search is unavailable."));
      return;
    }
    if (this.restartPromise || this.restartTimer) return;
    if (!this.workerHost.current) {
      this.scheduleWorkerRestart("a queued request needs a worker", undefined, this.restartPendingForStartupFailure);
      return;
    }
    this.pumping = true;
    void this.dispatchNext().finally(() => {
      this.pumping = false;
      if (!this.active && !this.closed && this.queue.length > 0) this.pump();
    });
  }

  private async dispatchNext(): Promise<void> {
    const generation = this.workerHost.current;
    if (!generation) return;
    try {
      await generation.ready;
    } catch (error) {
      // A failed generation has already been detached and its failure policy has run.
      if (!this.workerHost.isCurrent(generation)) return;
      this.failQueued(error instanceof Error ? error : new ClientSafeError("Japanese search is unavailable."));
      return;
    }
    if (this.closed || this.active || this.queue.length === 0 || !this.workerHost.isCurrent(generation)) return;

    let entry: QueuedSearch | undefined;
    while ((entry = this.queue.shift())) {
      if (entry.signal?.aborted) {
        this.finishEntry(entry, undefined, new ClientSafeError("Japanese search was cancelled."));
        continue;
      }
      break;
    }
    if (!entry) return;

    if (entry.queueTimeout) clearTimeout(entry.queueTimeout);
    entry.queueTimeout = undefined;
    this.active = entry;
    try {
      this.workerHost.postMessage(generation, { type: "search", id: entry.id, ...entry.request });
    } catch (error) {
      this.active = undefined;
      this.finishEntry(entry, undefined, new ClientSafeError("Japanese search is unavailable.", { cause: error }));
      this.workerHost.fail(generation, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onMessage(message: WorkerMessage, generation: WorkerGeneration<WorkerMetadata>): void {
    if (message.type === "ready") {
      if (this.workerHost.resolveReady(generation, message.metadata)) {
        // The retry budget protects against failures before ready. A healthy boot starts
        // a fresh budget, so slow queries cannot permanently exhaust worker recovery.
        this.restartAttempts = 0;
        this.options.log?.("[japanese-search] worker ready", {
          initializationMs: Date.now() - generation.startedAt,
          indexedAt: message.metadata.indexed_at,
          indexedRecords: message.metadata.source_record_count,
        });
      }
      this.pump();
      return;
    }
    if (message.type === "startup-error") {
      this.workerHost.rejectReady(generation, new Error(message.message));
      this.options.log?.("[japanese-search] worker could not open the index:", message.message, {
        initializationMs: Date.now() - generation.startedAt,
      });
      this.startupFailed = true;
      void this.workerHost.terminate(generation).catch((error) => {
        this.options.log?.("[japanese-search] worker termination failed:", error);
      });
      if (this.active) {
        this.finishEntry(this.active, undefined, new ClientSafeError("Japanese search is unavailable."));
        this.active = undefined;
      }
      this.failQueued(new ClientSafeError("Japanese search is unavailable."));
      return;
    }
    if (message.type === "started") {
      const active = this.active;
      if (!active || active.id !== message.id || active.timeout) return;
      const executionTimeoutMs = this.options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
      active.timeout = setTimeout(() => this.onExecutionTimeout(active, generation, executionTimeoutMs), executionTimeoutMs);
      active.timeout.unref();
      return;
    }
    if (message.type !== "result") return;
    const active = this.active;
    if (!active || active.id !== message.id) return;
    this.active = undefined;
    if (message.ok) {
      this.finishEntry(active, message.value);
    } else {
      if (message.operatorMessage) this.options.log?.("[japanese-search] query failed:", message.operatorMessage);
      if (message.code === "no_searchable_tokens") {
        this.finishEntry(active, undefined, new ClientSafeError("The tokenizer produced no searchable tokens for this query."));
      } else {
        this.finishEntry(active, undefined, new ClientSafeError("Japanese search failed; check the server log and rebuild the index if needed."));
      }
    }
    this.pump();
  }

  private onExecutionTimeout(entry: QueuedSearch, generation: WorkerGeneration<WorkerMetadata>, timeoutMs: number): void {
    if (this.active !== entry || !this.workerHost.isCurrent(generation)) return;
    this.active = undefined;
    entry.timeout = undefined;
    this.options.log?.("[japanese-search] query exceeded its execution limit", { requestId: entry.id, timeoutMs });
    this.finishEntry(entry, undefined, new ClientSafeError(`Japanese search exceeded the ${Math.max(1, Math.ceil(timeoutMs / 1000))}-second execution limit.`));
    this.restartWorker("search execution timeout", generation);
  }

  private onWorkerFailure(failure: WorkerHostFailure, generation: WorkerGeneration<WorkerMetadata>): void {
    const error = failure.type === "error"
      ? failure.error
      : failure.type === "exit"
        ? new Error(`Japanese search worker exited unexpectedly with code ${failure.code}`)
        : new Error(`Japanese search worker startup exceeded ${failure.timeoutMs} ms`);
    this.options.log?.("[japanese-search] worker failure:", error.message);

    if (failure.type === "startup-timeout") {
      this.startupFailed = true;
      if (this.active) {
        this.finishEntry(this.active, undefined, new ClientSafeError("Japanese search is unavailable."));
        this.active = undefined;
      }
      this.failQueued(new ClientSafeError("Japanese search is unavailable."));
      void this.workerHost.terminate(generation).catch((terminationError) => {
        this.options.log?.("[japanese-search] worker termination failed:", terminationError);
      });
      return;
    }

    const countsTowardStartupRetryBudget = !this.workerHost.hasReachedReady(generation);
    if (this.active) {
      this.finishEntry(this.active, undefined, new ClientSafeError("Japanese search worker failed; retry the request."));
      this.active = undefined;
    }
    this.restartWorker("worker failure", generation, countsTowardStartupRetryBudget);
  }

  private restartWorker(
    reason: string,
    workerToTerminate?: WorkerGeneration<WorkerMetadata>,
    countsTowardStartupRetryBudget = false,
  ): void {
    if (this.closed) return;
    const oldWorker = workerToTerminate ?? this.workerHost.current;
    if (this.queue.length === 0) {
      if (countsTowardStartupRetryBudget) this.restartPendingForStartupFailure = true;
      if (oldWorker) {
        // Track termination even while idle. A request arriving before terminate()
        // settles must not start a replacement alongside the old Worker.
        let termination: Promise<void>;
        termination = this.workerHost.terminate(oldWorker)
          .then(() => undefined)
          .catch((error) => {
            this.options.log?.("[japanese-search] worker termination failed:", error);
          })
          .then(() => {
            if (this.restartPromise === termination) this.restartPromise = undefined;
            this.pump();
          });
        this.restartPromise = termination;
      }
      return;
    }
    this.scheduleWorkerRestart(reason, oldWorker, countsTowardStartupRetryBudget);
  }

  /** Restart only while callers are waiting; only failures before ready consume the retry budget. */
  private scheduleWorkerRestart(
    reason: string,
    workerToTerminate?: WorkerGeneration<WorkerMetadata>,
    countsTowardStartupRetryBudget = false,
  ): void {
    if (this.closed || this.startupFailed || this.queue.length === 0 || this.restartPromise || this.restartTimer) return;

    const maxAttempts = this.options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
    if (countsTowardStartupRetryBudget && this.restartAttempts >= maxAttempts) {
      // Keep the startup-failure marker set: future demand must not bypass the exhausted
      // budget after the current queue has been rejected.
      this.restartPendingForStartupFailure = true;
      // Even when the startup retry budget is exhausted, detach and terminate the failed
      // generation before failing callers.
      if (workerToTerminate) {
        void this.workerHost.terminate(workerToTerminate).catch((error) => {
          this.options.log?.("[japanese-search] worker termination failed:", error);
        });
      }
      this.options.log?.("[japanese-search] worker restart limit reached; failing queued searches", {
        attempts: this.restartAttempts,
        maxAttempts,
      });
      this.failQueued(new ClientSafeError("Japanese search is unavailable after repeated worker failures; restart the server."));
      return;
    }

    if (countsTowardStartupRetryBudget) {
      this.restartAttempts += 1;
      this.restartPendingForStartupFailure = false;
    }
    const baseDelayMs = this.options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
    const maxDelayMs = this.options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS;
    const retryExponent = Math.max(0, this.restartAttempts - 1);
    const delayMs = Math.min(baseDelayMs * (2 ** retryExponent), maxDelayMs);
    this.options.log?.("[japanese-search] scheduling worker restart", {
      reason,
      attempt: this.restartAttempts,
      maxAttempts,
      delayMs,
      queuedRequests: this.queue.length,
    });

    const termination = workerToTerminate
      ? this.workerHost.terminate(workerToTerminate).catch((error) => {
        this.options.log?.("[japanese-search] worker termination failed:", error);
      })
      : Promise.resolve();

    let restart: Promise<void>;
    restart = termination.then(() => {
      if (this.restartPromise === restart) this.restartPromise = undefined;
      if (this.closed || this.startupFailed || this.queue.length === 0) {
        this.pump();
        return;
      }

      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (this.closed || this.startupFailed || this.queue.length === 0) {
          this.pump();
          return;
        }
        try {
          this.startWorker();
        } catch (error) {
          this.options.log?.("[japanese-search] worker spawn failed:", error);
          this.scheduleWorkerRestart("worker spawn failed", undefined, true);
        }
      }, delayMs);
      this.restartTimer.unref();
    });
    this.restartPromise = restart;
    void restart.catch((error) => {
      if (this.restartPromise === restart) this.restartPromise = undefined;
      this.options.log?.("[japanese-search] worker restart failed:", error);
      this.pump();
    });
  }

  private onQueueWaitTimeout(entry: QueuedSearch, timeoutMs: number): void {
    const index = this.queue.indexOf(entry);
    if (index < 0 || entry.settled) return;
    this.queue.splice(index, 1);
    this.options.log?.("[japanese-search] queued search expired before dispatch", {
      requestId: entry.id,
      timeoutMs,
    });
    const limit = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.ceil(timeoutMs / 1000)} seconds`;
    this.finishEntry(entry, undefined, new ClientSafeError(
      `Japanese search exceeded its ${limit} queue-wait limit; retry the request.`,
    ));
    this.pump();
  }

  private cancel(entry: QueuedSearch): void {
    if (entry.settled) return;
    if (this.active === entry) {
      // A synchronous SQLite query cannot process a cancel message until it returns.
      // Release the MCP caller now, but keep the execution timer and worker slot occupied.
      if (entry.abortListener && entry.signal) {
        entry.signal.removeEventListener("abort", entry.abortListener);
        entry.abortListener = undefined;
      }
      entry.settled = true;
      entry.reject(new ClientSafeError("Japanese search was cancelled."));
      return;
    }
    const index = this.queue.indexOf(entry);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.finishEntry(entry, undefined, new ClientSafeError("Japanese search was cancelled."));
      this.pump();
    }
  }

  private finishEntry(entry: QueuedSearch, value?: unknown, error?: Error): void {
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = undefined;
    if (entry.queueTimeout) clearTimeout(entry.queueTimeout);
    entry.queueTimeout = undefined;
    if (entry.abortListener && entry.signal) {
      entry.signal.removeEventListener("abort", entry.abortListener);
      entry.abortListener = undefined;
    }
    if (entry.settled) return;
    entry.settled = true;
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  private failQueued(error: Error): void {
    for (const entry of this.queue.splice(0)) this.finishEntry(entry, undefined, error);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }
}
