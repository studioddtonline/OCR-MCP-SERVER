import { Worker } from "node:worker_threads";
import { ClientSafeError } from "../../shared/errors.js";
import { WorkerHost, type WorkerGeneration, type WorkerHostFailure } from "../../shared/worker-host.js";

const MAX_WAITING_IMAGE_READS = 30;
const IMAGE_READ_TIMEOUT_MS = 180_000;
const WORKER_STARTUP_TIMEOUT_MS = 10_000;
const CANCEL_ACK_TIMEOUT_MS = 10_000;

type ImageReadResult = {
  data: string;
  mimeType: string;
  sizeBytes: number;
  bookDirectory: string;
  fileName: string;
};

type WorkerReadyMessage = { type: "ready" };
type WorkerResultMessage = { type: "result"; id: number; result: ImageReadResult };
type WorkerCancelledMessage = { type: "cancelled"; id: number };
type WorkerFailureMessage = {
  type: "failure";
  id: number;
  error: { name: string; message: string; causeMessage?: string; clientSafe: boolean };
};
type WorkerMessage = WorkerReadyMessage | WorkerResultMessage | WorkerCancelledMessage | WorkerFailureMessage;

interface ImageReadJob {
  id: number;
  rootPath: string | undefined;
  bookDirectory: string;
  fileName: string;
  signal?: AbortSignal;
  resolve(value: ImageReadResult): void;
  reject(reason: unknown): void;
  abortListener?: () => void;
  timeout?: NodeJS.Timeout;
  cancelAckTimeout?: NodeJS.Timeout;
  cancelled: boolean;
  timedOut: boolean;
  sent: boolean;
  settled: boolean;
  workerGeneration?: WorkerGeneration<void>;
}

function abortError(): Error {
  const error = new Error("Image retrieval was cancelled");
  error.name = "AbortError";
  return error;
}

function workerError(error: WorkerFailureMessage["error"]): Error {
  if (error.clientSafe) {
    return new ClientSafeError(error.message, error.causeMessage ? { cause: new Error(error.causeMessage) } : undefined);
  }
  const result = new Error(error.message, error.causeMessage ? { cause: new Error(error.causeMessage) } : undefined);
  result.name = error.name || "Error";
  return result;
}

/**
 * FIFO for image reads, owned by one OriginalImageRepository. MCP HTTP creates server objects per
 * request, so the Runtime creates that repository once and injects it into every server; they
 * therefore share this one-reader limit. shutdown() is terminal for the instance.
 */
export class ImageReadQueue {
  private readonly waiting: ImageReadJob[] = [];
  private active: ImageReadJob | undefined;
  private closed = false;
  private readonly workerHost = new WorkerHost<WorkerMessage, void>({
    workerFactory: () => new Worker(new URL("./image-worker.mjs", import.meta.url), { name: "ocr-original-image-reader" }),
    startupTimeoutMs: WORKER_STARTUP_TIMEOUT_MS,
    onMessage: (generation, message) => this.onWorkerMessage(generation, message),
    onFailure: (generation, failure) => this.onWorkerFailure(generation, failure),
  });
  private nextId = 1;

  enqueue(rootPath: string | undefined, bookDirectory: string, fileName: string, signal?: AbortSignal): Promise<ImageReadResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.closed) return Promise.reject(new ClientSafeError("Image retrieval is unavailable"));
    if (this.waiting.length >= MAX_WAITING_IMAGE_READS) {
      return Promise.reject(new ClientSafeError("Image retrieval queue is full; retry shortly"));
    }

    return new Promise<ImageReadResult>((resolve, reject) => {
      const job: ImageReadJob = {
        id: this.nextId++, rootPath, bookDirectory, fileName, signal, resolve, reject,
        cancelled: false, timedOut: false, sent: false, settled: false,
      };
      if (signal) {
        job.abortListener = () => this.cancel(job);
        signal.addEventListener("abort", job.abortListener, { once: true });
      }
      job.timeout = setTimeout(() => this.timeout(job), IMAGE_READ_TIMEOUT_MS);
      this.waiting.push(job);
      this.pump();
    });
  }

  /** Terminal: pending work is rejected and later enqueue() calls fail. Idempotent. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Image retrieval worker is shutting down");
    for (const job of this.waiting.splice(0)) this.settle(job, undefined, error);
    if (this.active) {
      const active = this.active;
      this.active = undefined;
      if (active.cancelAckTimeout) clearTimeout(active.cancelAckTimeout);
      active.cancelAckTimeout = undefined;
      this.settle(active, undefined, error);
    }
    const generation = this.workerHost.current;
    if (generation) void this.workerHost.terminate(generation, error).catch(() => undefined);
  }

  private cancel(job: ImageReadJob): void {
    if (job.settled) return;
    if (this.active === job) {
      job.cancelled = true;
      this.requestWorkerCancellation(job);
      // Let the MCP handler unwind immediately, but keep the active slot until the Worker
      // acknowledges cancellation so a second read cannot overlap the first one.
      this.settle(job, undefined, abortError());
      return;
    }
    const index = this.waiting.indexOf(job);
    if (index >= 0) {
      this.waiting.splice(index, 1);
      this.settle(job, undefined, abortError());
      this.pump();
    }
  }

  private timeout(job: ImageReadJob): void {
    if (job.settled) return;
    if (this.active === job) {
      job.cancelled = true;
      job.timedOut = true;
      this.requestWorkerCancellation(job);
      // Reject the caller at the deadline, while retaining the active slot until the Worker
      // actually stops. This preserves the one-read-at-a-time guarantee on slow storage.
      this.settle(job, undefined, new ClientSafeError("Image retrieval timed out; retry shortly"));
      return;
    }
    const index = this.waiting.indexOf(job);
    if (index >= 0) {
      this.waiting.splice(index, 1);
      this.settle(job, undefined, new ClientSafeError("Image retrieval timed out; retry shortly"));
      this.pump();
    }
  }

  private requestWorkerCancellation(job: ImageReadJob): void {
    if (!job.sent) return;
    const generation = job.workerGeneration;
    if (!generation || !this.workerHost.isCurrent(generation)) return;
    try {
      this.workerHost.postMessage(generation, { type: "cancel", id: job.id });
    } catch (error) {
      this.workerHost.fail(generation, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (job.cancelAckTimeout) clearTimeout(job.cancelAckTimeout);
    job.cancelAckTimeout = setTimeout(() => {
      if (this.active === job && this.workerHost.isCurrent(generation)) {
        this.workerHost.fail(generation, new Error("Original image Worker did not acknowledge cancellation"));
      }
    }, CANCEL_ACK_TIMEOUT_MS);
  }

  private pump(): void {
    if (this.closed || this.active || this.waiting.length === 0) return;
    const job = this.waiting.shift()!;
    if (job.signal?.aborted) {
      this.settle(job, undefined, abortError());
      this.pump();
      return;
    }
    this.active = job;
    void this.dispatch(job);
  }

  private async dispatch(job: ImageReadJob): Promise<void> {
    let generation: WorkerGeneration<void> | undefined;
    try {
      // Starting is synchronous, so shutdown() cannot interleave between pump() and start().
      generation = this.workerHost.current ?? this.workerHost.start();
      job.workerGeneration = generation;
      await generation.ready;
      // shutdown() clears `active`, so this also covers "closed while awaiting ready".
      if (this.active !== job) return;
      if (job.cancelled || job.signal?.aborted) {
        this.finishActive(job, undefined, abortError());
        return;
      }
      this.workerHost.ref(generation);
      job.sent = true;
      this.workerHost.postMessage(generation, {
        type: "read",
        id: job.id,
        rootPath: job.rootPath,
        bookDirectory: job.bookDirectory,
        fileName: job.fileName,
      });
    } catch (error) {
      if (generation) {
        await this.workerHost.terminate(generation, error instanceof Error ? error : new Error(String(error))).catch(() => undefined);
      }
      if (this.active === job) this.finishActive(job, undefined, error);
    }
  }

  private onWorkerMessage(generation: WorkerGeneration<void>, message: WorkerMessage): void {
    if (message.type === "ready") {
      this.workerHost.resolveReady(generation, undefined);
      return;
    }
    const job = this.active;
    if (!job || job.workerGeneration !== generation || message.id !== job.id) return;
    if (message.type === "result") {
      this.finishActive(job, message.result);
    } else if (message.type === "cancelled") {
      this.finishActive(job, undefined, job.timedOut ? new ClientSafeError("Image retrieval timed out; retry shortly") : abortError());
    } else if (message.type === "failure") {
      this.finishActive(job, undefined, workerError(message.error));
    }
  }

  private onWorkerFailure(generation: WorkerGeneration<void>, failure: WorkerHostFailure): void {
    const error = failure.type === "error"
      ? failure.error
      : failure.type === "exit"
        ? new Error(`Original image Worker exited unexpectedly (code ${failure.code})`)
        : new Error(`Original image Worker startup timed out after ${failure.timeoutMs} ms`);
    const active = this.active;
    // `active` stays set until termination settles, which is what keeps a replacement
    // Worker from overlapping the failed one.
    void this.workerHost.terminate(generation, error).catch(() => undefined).finally(() => {
      if (active && this.active === active && active.workerGeneration === generation) {
        this.finishActive(active, undefined, error);
      } else {
        this.pump();
      }
    });
  }

  private finishActive(job: ImageReadJob, result?: ImageReadResult, error?: unknown): void {
    if (this.active !== job) return;
    this.active = undefined;
    if (job.cancelAckTimeout) clearTimeout(job.cancelAckTimeout);
    job.cancelAckTimeout = undefined;
    if (job.timedOut) error = new ClientSafeError("Image retrieval timed out; retry shortly");
    else if (job.cancelled || job.signal?.aborted) error = abortError();
    this.settle(job, result, error);
    if (job.workerGeneration) this.workerHost.unref(job.workerGeneration);
    this.pump();
  }

  private settle(job: ImageReadJob, result?: ImageReadResult, error?: unknown): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timeout) clearTimeout(job.timeout);
    if (job.signal && job.abortListener) job.signal.removeEventListener("abort", job.abortListener);
    if (error !== undefined) job.reject(error);
    else if (result) job.resolve(result);
    else job.reject(new Error("Image retrieval completed without a result"));
  }

}
