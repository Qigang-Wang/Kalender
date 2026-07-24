import { fetchWithTimeout } from "./fetch-with-timeout";

interface CachedResponse {
  readonly body: Uint8Array;
  readonly expiresAt: number;
  readonly headers: [string, string][];
  readonly status: number;
  readonly statusText: string;
}

const DEFAULT_CACHE_MS = 300;
const responseCache = new Map<string, CachedResponse>();
const inFlightRequests = new Map<string, Promise<CachedResponse>>();

export async function workspaceFetch(
  input: string,
  init: RequestInit = {},
  cacheMs = DEFAULT_CACHE_MS,
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET") return fetchWithTimeout(input, init);
  const key = `${method}:${input}`;
  const now = Date.now();
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > now) return responseFromCache(cached);
  if (cached) responseCache.delete(key);

  let pending = inFlightRequests.get(key);
  if (!pending) {
    const { signal: _callerSignal, ...sharedInit } = init;
    pending = fetchWithTimeout(input, { ...sharedInit, cache: "no-store" })
      .then(async (response) => {
        const entry: CachedResponse = {
          body: new Uint8Array(await response.arrayBuffer()),
          expiresAt: Date.now() + Math.max(0, cacheMs),
          headers: [...response.headers.entries()],
          status: response.status,
          statusText: response.statusText,
        };
        if (response.ok && cacheMs > 0) responseCache.set(key, entry);
        return entry;
      })
      .finally(() => inFlightRequests.delete(key));
    inFlightRequests.set(key, pending);
  }
  return responseFromCache(await pending);
}

export function invalidateWorkspaceFetch(...prefixes: readonly string[]): void {
  if (!prefixes.length) {
    responseCache.clear();
    return;
  }
  for (const key of responseCache.keys()) {
    if (prefixes.some((prefix) => key.startsWith(`GET:${prefix}`))) responseCache.delete(key);
  }
}

function responseFromCache(entry: CachedResponse): Response {
  return new Response(entry.body.slice(), {
    headers: entry.headers,
    status: entry.status,
    statusText: entry.statusText,
  });
}
