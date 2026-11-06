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

type WorkerLifecycle =
  | { kind: "starting"; restartAttempts: number }
  | { kind: "ready"; restartAttempts: number }
  | { kind: "idle"; restartAttempts: number; startupFailurePending: boolean }
  | {
      kind: "terminating";
      restartAttempts: number;
      startupFailurePending: boolean;
    }
  | { kind: "backoff"; restartAttempts: number; timer: NodeJS.Timeout }
  | { kind: "dead"; reason: "startup" | "retry-exhausted" }
  | { kind: "closed" };

interface RepositoryState {
  lifecycle: WorkerLifecycle;
  /** The queue pump is an orthogonal async dispatch lock, not a Worker lifecycle phase. */
  pumping: boolean;
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

function assertNever(value: never): never {
  throw new Error(`Unexpected Japanese search lifecycle state: ${JSON.stringify(value)}`);
}

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
  private state: RepositoryState = {
    lifecycle: { kind: "starting", restartAttempts: 0 },
    pumping: false,
  };
  private get closed(): boolean {
    return this.state.lifecycle.kind === "closed";
  }

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
    const lifecycle = this.state.lifecycle;
    if (lifecycle.kind === "backoff") clearTimeout(lifecycle.timer);
    this.state.lifecycle = { kind: "closed" };
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
    const attempts = this.currentRestartAttempts();
    this.state.lifecycle = { kind: "starting", restartAttempts: attempts };
    this.workerHost.start();
  }

  private pump(): void {
    const lifecycle = this.state.lifecycle;
    if (this.state.pumping || this.active || this.queue.length === 0) return;
    switch (lifecycle.kind) {
      case "dead":
        this.failQueued(new ClientSafeError(lifecycle.reason === "retry-exhausted"
          ? "Japanese search is unavailable after repeated worker failures; restart the server."
          : "Japanese search is unavailable."));
        return;
      case "closed":
      case "terminating":
      case "backoff":
        return;
      case "starting":
      case "ready":
      case "idle":
        break;
      default:
        assertNever(lifecycle);
    }
    if (!this.workerHost.current) {
      if (lifecycle.kind === "idle") {
        this.scheduleWorkerRestart("a queued request needs a worker", undefined, lifecycle.startupFailurePending);
      }
      return;
    }
    this.state.pumping = true;
    void this.dispatchNext().finally(() => {
      this.state.pumping = false;
      if (!this.active && !this.closed && this.queue.length > 0) this.pump();
    });
  }

  private currentRestartAttempts(): number {
    const lifecycle = this.state.lifecycle;
    return "restartAttempts" in lifecycle ? lifecycle.restartAttempts : 0;
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
        this.state.lifecycle = { kind: "ready", restartAttempts: 0 };
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
      this.state.lifecycle = { kind: "dead", reason: "startup" };
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
      this.state.lifecycle = { kind: "dead", reason: "startup" };
      if (this.active) {
        this.finishEntry(this.active, undefined, new ClientSafeError("Japanese search is unavailable."));
        this.active = undefined;
      }
      this.failQueued(new ClientSafeError("Japanese search is unavailable."));
      // WorkerHost already initiates termination for startup-timeout failures.
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
    const lifecycle = this.state.lifecycle;
    if (lifecycle.kind === "dead" || lifecycle.kind === "closed") return;
    const oldWorker = workerToTerminate ?? this.workerHost.current;
    const restartAttempts = this.currentRestartAttempts();
    const startupFailurePending = lifecycle.kind === "idle" && lifecycle.startupFailurePending;

    if (this.queue.length === 0) {
      const pending = startupFailurePending || countsTowardStartupRetryBudget;
      if (oldWorker) {
        const termination = this.workerHost.terminate(oldWorker).catch((error) => {
          this.options.log?.("[japanese-search] worker termination failed:", error);
          return 0;
        });
        const terminating: WorkerLifecycle = {
          kind: "terminating",
          restartAttempts,
          startupFailurePending: pending,
        };
        this.state.lifecycle = terminating;
        void termination.then(() => {
          if (this.state.lifecycle !== terminating) return;
          this.state.lifecycle = { kind: "idle", restartAttempts, startupFailurePending: pending };
          this.pump();
        });
      } else {
        this.state.lifecycle = { kind: "idle", restartAttempts, startupFailurePending: pending };
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
    const current = this.state.lifecycle;
    if (this.closed || current.kind === "dead" || current.kind === "closed" ||
        this.queue.length === 0 || current.kind === "terminating" || current.kind === "backoff") return;

    const maxAttempts = this.options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
    let restartAttempts = this.currentRestartAttempts();
    if (countsTowardStartupRetryBudget && restartAttempts >= maxAttempts) {
      // A WorkerHost failure already initiated termination; no replacement is started here.
      this.state.lifecycle = { kind: "dead", reason: "retry-exhausted" };
      this.options.log?.("[japanese-search] worker restart limit reached; failing queued searches", {
        attempts: restartAttempts,
        maxAttempts,
      });
      this.failQueued(new ClientSafeError("Japanese search is unavailable after repeated worker failures; restart the server."));
      return;
    }

    if (countsTowardStartupRetryBudget) restartAttempts += 1;
    const baseDelayMs = this.options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
    const maxDelayMs = this.options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS;
    const retryExponent = Math.max(0, restartAttempts - 1);
    const delayMs = Math.min(baseDelayMs * (2 ** retryExponent), maxDelayMs);
    this.options.log?.("[japanese-search] scheduling worker restart", {
      reason,
      attempt: restartAttempts,
      maxAttempts,
      delayMs,
      queuedRequests: this.queue.length,
    });

    // WorkerHost returns the same termination Promise for repeated calls on a generation.
    // The lifecycle state object, rather than a self-referential Promise chain, guards
    // against stale completion callbacks.
    const termination = workerToTerminate
      ? this.workerHost.terminate(workerToTerminate).catch((error) => {
        this.options.log?.("[japanese-search] worker termination failed:", error);
        return 0;
      })
      : Promise.resolve(0);
    const terminating: WorkerLifecycle = {
      kind: "terminating",
      restartAttempts,
      startupFailurePending: false,
    };
    this.state.lifecycle = terminating;

    void termination.then(() => {
      if (this.state.lifecycle !== terminating) return;
      if (this.closed || this.queue.length === 0) {
        this.state.lifecycle = { kind: "idle", restartAttempts, startupFailurePending: false };
        this.pump();
        return;
      }

      const timer = setTimeout(() => {
        if (this.state.lifecycle !== backoff) return;
        this.state.lifecycle = { kind: "idle", restartAttempts, startupFailurePending: false };
        if (this.closed || this.queue.length === 0) {
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
      timer.unref();
      const backoff: WorkerLifecycle = { kind: "backoff", restartAttempts, timer };
      this.state.lifecycle = backoff;
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

}
