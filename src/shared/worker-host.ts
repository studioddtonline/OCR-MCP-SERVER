/**
 * Minimal EventEmitter-like surface used by the shared main-thread Worker host.
 * Keep `on` as one broad signature: Node's Worker exposes an overloaded `on`, and
 * mirroring those overloads here makes structural assignment fragile across
 * @types/node versions. The host narrows the message payload at its own boundary.
 */
export interface WorkerThreadLike {
  on(event: string | symbol, listener: (...args: any[]) => void): void;
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  ref?(): void;
  unref?(): void;
}

export interface WorkerGeneration<TReady> {
  readonly id: number;
  readonly startedAt: number;
  readonly ready: Promise<TReady>;
}

export type WorkerHostFailure =
  | { type: "error"; error: Error }
  | { type: "exit"; code: number }
  | { type: "startup-timeout"; timeoutMs: number };

export interface WorkerHostOptions<TMessage, TReady> {
  workerFactory: () => WorkerThreadLike;
  startupTimeoutMs: number;
  onMessage: (generation: WorkerGeneration<TReady>, message: TMessage) => void;
  onFailure: (generation: WorkerGeneration<TReady>, failure: WorkerHostFailure) => void;
}

type ReadyState = "pending" | "resolved" | "rejected";

interface GenerationState<TMessage, TReady> {
  generation: WorkerGeneration<TReady>;
  worker: WorkerThreadLike;
  resolveReady: (value: TReady) => void;
  rejectReady: (error: Error) => void;
  readyState: ReadyState;
  failureDelivered: boolean;
  startupTimer: NodeJS.Timeout | undefined;
  termination: Promise<number> | undefined;
}

/**
 * Owns Worker creation and lifecycle only. Queues, cancellation, execution deadlines,
 * retry policy, and message interpretation remain with the feature using the Worker.
 */
export class WorkerHost<TMessage, TReady> {
  private readonly generations = new WeakMap<WorkerGeneration<TReady>, GenerationState<TMessage, TReady>>();
  private currentState: GenerationState<TMessage, TReady> | undefined;
  private nextGenerationId = 1;

  constructor(private readonly options: WorkerHostOptions<TMessage, TReady>) {}

  get current(): WorkerGeneration<TReady> | undefined {
    return this.currentState?.generation;
  }

  start(): WorkerGeneration<TReady> {
    if (this.currentState) throw new Error("A Worker generation is already active");

    const worker = this.options.workerFactory();
    let resolveReady!: (value: TReady) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<TReady>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // A Worker can fail before the feature starts awaiting this generation's ready promise.
    void ready.catch(() => undefined);

    const generation: WorkerGeneration<TReady> = {
      id: this.nextGenerationId++,
      startedAt: Date.now(),
      ready,
    };
    const state: GenerationState<TMessage, TReady> = {
      generation,
      worker,
      resolveReady,
      rejectReady,
      readyState: "pending",
      failureDelivered: false,
      startupTimer: undefined,
      termination: undefined,
    };
    this.generations.set(generation, state);
    this.currentState = state;

    state.startupTimer = setTimeout(() => {
      this.handleFailure(state, { type: "startup-timeout", timeoutMs: this.options.startupTimeoutMs });
    }, this.options.startupTimeoutMs);
    state.startupTimer.unref();

    worker.on("message", (message: TMessage) => {
      if (this.currentState === state) this.options.onMessage(generation, message);
    });
    worker.on("error", (error: Error) => this.handleFailure(state, { type: "error", error }));
    worker.on("exit", (code: number) => this.handleFailure(state, { type: "exit", code }));

    return generation;
  }

  isCurrent(generation: WorkerGeneration<TReady>): boolean {
    return this.currentState === this.stateFor(generation);
  }

  hasReachedReady(generation: WorkerGeneration<TReady>): boolean {
    return this.stateFor(generation).readyState === "resolved";
  }

  resolveReady(generation: WorkerGeneration<TReady>, value: TReady): boolean {
    const state = this.stateFor(generation);
    if (this.currentState !== state || state.readyState !== "pending") return false;
    state.readyState = "resolved";
    this.clearStartupTimer(state);
    state.resolveReady(value);
    return true;
  }

  rejectReady(generation: WorkerGeneration<TReady>, error: Error): boolean {
    const state = this.stateFor(generation);
    if (this.currentState !== state || state.readyState !== "pending") return false;
    state.readyState = "rejected";
    this.clearStartupTimer(state);
    state.rejectReady(error);
    return true;
  }

  postMessage(generation: WorkerGeneration<TReady>, value: unknown): void {
    const state = this.stateFor(generation);
    if (this.currentState !== state) throw new Error("Cannot post a message to a detached Worker generation");
    state.worker.postMessage(value);
  }

  ref(generation: WorkerGeneration<TReady>): void {
    const state = this.stateFor(generation);
    if (this.currentState === state) state.worker.ref?.();
  }

  unref(generation: WorkerGeneration<TReady>): void {
    const state = this.stateFor(generation);
    if (this.currentState === state) state.worker.unref?.();
  }

  /** Report a feature-level fatal condition (for example, a missing cancellation ACK). */
  fail(generation: WorkerGeneration<TReady>, error: Error): void {
    this.handleFailure(this.stateFor(generation), { type: "error", error });
  }

  /** Detaches immediately; repeated calls share the same awaitable termination operation. */
  terminate(generation: WorkerGeneration<TReady>, reason = new Error("Worker generation was terminated")): Promise<number> {
    const state = this.stateFor(generation);
    if (this.currentState === state) this.currentState = undefined;
    this.clearStartupTimer(state);
    if (state.readyState === "pending") {
      state.readyState = "rejected";
      state.rejectReady(reason);
    }
    if (!state.termination) {
      state.termination = Promise.resolve().then(() => state.worker.terminate());
    }
    return state.termination;
  }

  private handleFailure(state: GenerationState<TMessage, TReady>, failure: WorkerHostFailure): void {
    if (this.currentState !== state || state.failureDelivered) return;
    state.failureDelivered = true;
    this.currentState = undefined;
    this.clearStartupTimer(state);

    if (state.readyState === "pending") {
      state.readyState = "rejected";
      state.rejectReady(this.failureError(failure));
    }

    this.options.onFailure(state.generation, failure);
  }

  private failureError(failure: WorkerHostFailure): Error {
    switch (failure.type) {
      case "error": return failure.error;
      case "exit": return new Error(`Worker exited unexpectedly with code ${failure.code}`);
      case "startup-timeout": return new Error(`Worker startup exceeded ${failure.timeoutMs} ms`);
    }
  }

  private clearStartupTimer(state: GenerationState<TMessage, TReady>): void {
    if (state.startupTimer) clearTimeout(state.startupTimer);
    state.startupTimer = undefined;
  }

  private stateFor(generation: WorkerGeneration<TReady>): GenerationState<TMessage, TReady> {
    const state = this.generations.get(generation);
    if (!state) throw new Error("Worker generation does not belong to this host");
    return state;
  }
}
