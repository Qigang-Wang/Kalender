import assert from "node:assert/strict";

import {
  fetchWithTimeout,
  InvalidApiResponseError,
  readApiJson,
  RequestTimeoutError,
  type FetchImplementation,
} from "./fetch-with-timeout";

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

  const json = await readApiJson<{ readonly ok: boolean }>(new Response('{"ok":true}', {
    headers: { "content-type": "application/json" },
    status: 200,
  }), "Testschnittstelle konnte nicht gelesen werden");
  assert.equal(json.ok, true);

  await assert.rejects(
    readApiJson(new Response("<!DOCTYPE html><html><body>Gateway error</body></html>", {
      headers: { "content-type": "text/html" },
      status: 502,
    }), "E-Mail-Text konnte nicht gelesen werden"),
    (error: unknown) => error instanceof InvalidApiResponseError
      && error.status === 502
      && error.message === "E-Mail-Text konnte nicht gelesen werden: Der Server hat eine Webseite statt API-Daten zurückgegeben (HTTP 502)",
  );

  await assert.rejects(
    readApiJson(new Response(null, { status: 503 }), "E-Mail-Text konnte nicht gelesen werden"),
    (error: unknown) => error instanceof InvalidApiResponseError
      && error.status === 503
      && error.message.includes("keinen Inhalt zurückgegeben"),
  );

  console.log("Fetch and API response tests passed");
}

void main();
