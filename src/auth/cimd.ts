// Client ID Metadata Document (CIMD) resolver.
// https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
//
// claude.ai は client_id として HTTPS URL を送ってくる。この URL からメタデータ JSON を取得し、
// 1) 文書内の client_id が URL と完全一致すること
// 2) redirect_uris のうち、サーバー側の許可リストに含まれるものだけを採用すること
// を確認する。SSRF 防止のため、取得先ホストは許可リストに限定し、リダイレクトは追わない。

export interface CimdDocument {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export interface CimdOptions {
  allowedHosts: string[];
  allowedRedirectUris: string[];
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  timeoutMs?: number;
  negativeTtlMs?: number;
  maxCacheEntries?: number;
  maxConcurrentFetches?: number;
}

const MAX_BYTES = 64 * 1024;
const DEFAULT_NEGATIVE_TTL_MS = 30 * 1000;
const MAX_CACHE_ENTRIES = 256;
const MAX_IN_FLIGHT_FETCHES = 32;

export function looksLikeUrlClientId(clientId: string): boolean {
  return /^https:\/\//i.test(clientId);
}

export function createCimdResolver(options: CimdOptions) {
  const allowedHosts = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  const allowedRedirects = new Set(options.allowedRedirectUris);
  const doFetch = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? 5000; // Claude 側のタイムアウトは 10 秒
  const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const maxCacheEntries = Math.max(1, options.maxCacheEntries ?? MAX_CACHE_ENTRIES);
  const maxConcurrentFetches = Math.max(1, options.maxConcurrentFetches ?? MAX_IN_FLIGHT_FETCHES);
  const cache = new Map<string, { doc: CimdDocument; expiresAt: number }>();
  const negativeCache = new Map<string, { message: string; expiresAt: number }>();
  const inFlight = new Map<string, Promise<CimdDocument>>();

  function pruneCaches(now: number): void {
    for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
    for (const [key, entry] of negativeCache) if (entry.expiresAt <= now) negativeCache.delete(key);
    while (cache.size + negativeCache.size > maxCacheEntries) {
      const positiveKey = cache.keys().next().value as string | undefined;
      const negativeKey = negativeCache.keys().next().value as string | undefined;
      if (negativeKey !== undefined) negativeCache.delete(negativeKey);
      else if (positiveKey !== undefined) cache.delete(positiveKey);
      else break;
    }
  }

  function makeCacheRoom(): void {
    pruneCaches(Date.now());
    while (cache.size + negativeCache.size >= maxCacheEntries) {
      const negativeKey = negativeCache.keys().next().value as string | undefined;
      const positiveKey = cache.keys().next().value as string | undefined;
      if (negativeKey !== undefined) negativeCache.delete(negativeKey);
      else if (positiveKey !== undefined) cache.delete(positiveKey);
      else break;
    }
  }

  async function readResponseTextLimited(response: Response): Promise<string> {
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader !== null) {
      const declaredLength = Number(lengthHeader);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("CIMD document too large");
      }
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!part.value) continue;
        total += part.value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error("CIMD document too large");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  async function fetchDocument(clientId: string): Promise<CimdDocument> {
    const url = new URL(clientId);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname === "/") {
      throw new Error("invalid CIMD client_id URL");
    }
    if (!allowedHosts.has(url.hostname.toLowerCase())) {
      throw new Error(`CIMD host not allowed: ${url.hostname}`);
    }
    const res = await doFetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`CIMD fetch failed: HTTP ${res.status}`);
    const text = await readResponseTextLimited(res);
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (doc.client_id !== clientId) throw new Error("CIMD client_id does not match its URL");
    if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every((x) => typeof x === "string")) {
      throw new Error("CIMD redirect_uris missing");
    }
    const method = doc.token_endpoint_auth_method;
    if (method !== undefined && method !== "none") throw new Error("CIMD token_endpoint_auth_method must be none");
    const redirectUris = (doc.redirect_uris as string[]).filter((u) => allowedRedirects.has(u));
    if (redirectUris.length === 0) throw new Error("CIMD has no allowed redirect_uris");
    const name = typeof doc.client_name === "string" && doc.client_name.trim() ? doc.client_name.trim().slice(0, 200) : url.hostname;
    return { clientId, clientName: name, redirectUris };
  }

  return {
    /** 取得・検証に失敗した場合は throw する。 */
    async resolve(clientId: string): Promise<CimdDocument> {
      const now = Date.now();
      pruneCaches(now);
      const hit = cache.get(clientId);
      if (hit) return hit.doc;
      const negativeHit = negativeCache.get(clientId);
      if (negativeHit) throw new Error(negativeHit.message);
      const pending = inFlight.get(clientId);
      if (pending) return pending;
      if (inFlight.size >= maxConcurrentFetches) throw new Error("Too many concurrent CIMD resolutions");

      const request = fetchDocument(clientId).then((doc) => {
        cache.delete(clientId);
        negativeCache.delete(clientId);
        makeCacheRoom();
        cache.set(clientId, { doc, expiresAt: Date.now() + ttlMs });
        return doc;
      }).catch((error: unknown) => {
        cache.delete(clientId);
        negativeCache.delete(clientId);
        makeCacheRoom();
        const message = (error instanceof Error ? error.message : "CIMD resolution failed").slice(0, 300);
        negativeCache.set(clientId, { message, expiresAt: Date.now() + negativeTtlMs });
        throw error;
      }).finally(() => {
        inFlight.delete(clientId);
      });
      inFlight.set(clientId, request);
      return request;
    },
  };
}
