import { OAuthValidationError, type OAuthClient, type OAuthStore } from "../oauth-store.js";
import { createCimdResolver, looksLikeUrlClientId } from "../cimd.js";

export type CimDResolver = ReturnType<typeof createCimdResolver>;

function sameUriSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** Resolve CIMD URL client IDs or look up a previously registered DCR client. */
export function createClientResolver(store: OAuthStore | undefined, cimd: CimDResolver) {
  const recentCimdLogs = new Map<string, number>();
  const logCimdRejection = (clientId: string, reason: string): void => {
    const now = Date.now();
    for (const [key, at] of recentCimdLogs) {
      if (now - at >= 30_000) recentCimdLogs.delete(key);
    }
    if (recentCimdLogs.has(clientId)) return;
    if (recentCimdLogs.size >= 256) {
      const oldest = recentCimdLogs.keys().next().value as string | undefined;
      if (oldest !== undefined) recentCimdLogs.delete(oldest);
    }
    recentCimdLogs.set(clientId, now);
    console.error("[oauth/cimd] rejected", clientId, reason);
  };

  return async function resolveClient(clientId: string): Promise<OAuthClient | undefined> {
    if (looksLikeUrlClientId(clientId)) {
      let doc: Awaited<ReturnType<typeof cimd.resolve>>;
      try {
        doc = await cimd.resolve(clientId);
      } catch (error) {
        logCimdRejection(clientId, error instanceof Error ? error.message : String(error));
        return undefined;
      }
      if (!store) return undefined;
      try {
        const existing = store.getClient(clientId);
        if (existing && existing.clientName === doc.clientName && sameUriSet(existing.redirectUris, doc.redirectUris)) {
          return existing;
        }
        return store.upsertClient({ clientId, clientName: doc.clientName, redirectUris: doc.redirectUris });
      } catch (error) {
        // Invalid metadata is an invalid client; unexpected storage errors propagate so the route can return 503.
        if (error instanceof OAuthValidationError) {
          logCimdRejection(clientId, error.message);
          return undefined;
        }
        throw error;
      }
    }
    return store?.getClient(clientId);
  };
}
