export const OCR_WRITE_RATE_WINDOW_MS = 60_000;
export const OCR_WRITE_PER_CLIENT_PER_MINUTE = 10;
export const OCR_WRITE_SERVER_PER_MINUTE = 30;

export type WriteLimitRejection = "client" | "server";

/** In-process rolling-window limiter. Limits are fixed in code and need no config restart. */
export class OcrWriteRateLimiter {
  private readonly allWrites: number[] = [];
  private readonly clientWrites = new Map<string, number[]>();
  private readonly lastLogAt = new Map<string, number>();

  consume(clientId: string, now = Date.now()): { allowed: true } | { allowed: false; rejectedBy: WriteLimitRejection; retryAfterSeconds: number } {
    const cutoff = now - OCR_WRITE_RATE_WINDOW_MS;
    this.prune(this.allWrites, cutoff);
    for (const [key, timestamps] of this.clientWrites) {
      this.prune(timestamps, cutoff);
      if (timestamps.length === 0) this.clientWrites.delete(key);
    }
    for (const [key, last] of this.lastLogAt) {
      if (now - last >= OCR_WRITE_RATE_WINDOW_MS) this.lastLogAt.delete(key);
    }

    const own = this.clientWrites.get(clientId) ?? [];
    this.prune(own, cutoff);
    if (this.allWrites.length >= OCR_WRITE_SERVER_PER_MINUTE) {
      return { allowed: false, rejectedBy: "server", retryAfterSeconds: this.retryAfter(this.allWrites, now) };
    }
    if (own.length >= OCR_WRITE_PER_CLIENT_PER_MINUTE) {
      return { allowed: false, rejectedBy: "client", retryAfterSeconds: this.retryAfter(own, now) };
    }

    own.push(now);
    this.clientWrites.set(clientId, own);
    this.allWrites.push(now);
    return { allowed: true };
  }

  /** Throttle repetitive operational logs to at most one message per key per minute. */
  shouldLog(key: string, now = Date.now()): boolean {
    const previous = this.lastLogAt.get(key);
    if (previous !== undefined && now - previous < OCR_WRITE_RATE_WINDOW_MS) return false;
    this.lastLogAt.set(key, now);
    return true;
  }

  private prune(timestamps: number[], cutoff: number): void {
    let removeCount = 0;
    while (removeCount < timestamps.length && timestamps[removeCount]! <= cutoff) removeCount += 1;
    if (removeCount > 0) timestamps.splice(0, removeCount);
  }

  private retryAfter(timestamps: number[], now: number): number {
    const first = timestamps[0] ?? now;
    return Math.max(1, Math.ceil((first + OCR_WRITE_RATE_WINDOW_MS - now) / 1000));
  }
}
