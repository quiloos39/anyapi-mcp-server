interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;

const cache = new Map<string, CacheEntry>();

export function buildCacheKey(
  method: string,
  pathTemplate: string,
  params?: Record<string, unknown>,
  body?: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): string {
  const parts = [method, pathTemplate];
  if (params && Object.keys(params).length > 0) {
    parts.push(JSON.stringify(params, Object.keys(params).sort()));
  }
  if (body && Object.keys(body).length > 0) {
    parts.push(JSON.stringify(body, Object.keys(body).sort()));
  }
  if (extraHeaders && Object.keys(extraHeaders).length > 0) {
    parts.push(JSON.stringify(extraHeaders, Object.keys(extraHeaders).sort()));
  }
  return parts.join("|");
}

export function getCached(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

/** Read and immediately evict a cache entry (one-shot consumption). */
export function consumeCached(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  if (Date.now() > entry.expiresAt) return undefined;
  return entry.data;
}

export function setCache(key: string, data: unknown, ttlMs: number = DEFAULT_TTL_MS): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

export function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) {
      cache.delete(key);
    }
  }
}

export function clearCache(): void {
  cache.clear();
}
