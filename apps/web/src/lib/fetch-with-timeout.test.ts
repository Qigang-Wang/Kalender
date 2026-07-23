import assert from "node:assert/strict";

import { fetchWithTimeout, RequestTimeoutError, type FetchImplementation } from "./fetch-with-timeout";

async function main() {
  const successfulFetch: FetchImplementation = async () => new Response('{"ok":true}', {
    headers: { "content-type": "application/json" },
    status: 200,
  });

  const response = await fetchWithTimeout("/api/test", {}, 50, successfulFetch);
  assert.equal(response.status, 200);

  const hangingFetch: FetchImplementation = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

  await assert.rejects(
    fetchWithTimeout("/api/test", {}, 5, hangingFetch),
    (error: unknown) => error instanceof RequestTimeoutError,
  );

  const caller = new AbortController();
  const callerAbort = fetchWithTimeout("/api/test", { signal: caller.signal }, 100, hangingFetch);
  caller.abort();
  await assert.rejects(callerAbort, (error: unknown) => !(error instanceof RequestTimeoutError));

  console.log("Fetch timeout tests passed");
}

void main();
