export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export interface LoginFailureWindow {
  count: number;
  resetAt: number;
}

/** Tracks failed consent-login attempts with the same pruning and reset semantics as the legacy handler. */
export class LoginLimiter {
  private readonly failures = new Map<string, LoginFailureWindow>();

  private prune(nowMs: number): void {
    if (this.failures.size < 1000) return;
    // Windows are kept in resetAt order: replacing an expired key moves it to the end.
    // Once the first live window is reached, every later entry is live as well.
    for (const [key, value] of this.failures) {
      if (value.resetAt > nowMs) break;
      this.failures.delete(key);
    }
  }

  getOrCreate(clientKey: string, nowMs: number): LoginFailureWindow {
    this.prune(nowMs);
    let failures = this.failures.get(clientKey);
    if (!failures || failures.resetAt <= nowMs) {
      // Delete first to preserve insertion order by expiry for prune().
      this.failures.delete(clientKey);
      failures = { count: 0, resetAt: nowMs + LOGIN_WINDOW_MS };
      this.failures.set(clientKey, failures);
    }
    return failures;
  }

  reset(clientKey: string): void {
    this.failures.delete(clientKey);
  }
}
