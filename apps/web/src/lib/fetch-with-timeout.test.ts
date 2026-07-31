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
  }), "无法读取测试接口");
  assert.equal(json.ok, true);

  await assert.rejects(
    readApiJson(new Response("<!DOCTYPE html><html><body>Gateway error</body></html>", {
      headers: { "content-type": "text/html" },
      status: 502,
    }), "无法读取邮件正文"),
    (error: unknown) => error instanceof InvalidApiResponseError
      && error.status === 502
      && error.message === "无法读取邮件正文：服务器返回了网页而不是接口数据（HTTP 502）",
  );

  await assert.rejects(
    readApiJson(new Response(null, { status: 503 }), "无法读取邮件正文"),
    (error: unknown) => error instanceof InvalidApiResponseError
      && error.status === 503
      && error.message.includes("服务器没有返回内容"),
  );

  console.log("Fetch and API response tests passed");
}

void main();
