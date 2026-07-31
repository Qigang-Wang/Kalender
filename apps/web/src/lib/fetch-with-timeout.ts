export const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

export class RequestTimeoutError extends Error {
  constructor() {
    super("请求超时，请检查电脑上的开发服务后重试");
    this.name = "RequestTimeoutError";
  }
}

export class InvalidApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InvalidApiResponseError";
  }
}

export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImplementation: FetchImplementation = fetch,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  init.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImplementation(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError();
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    init.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function readApiJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    throw new InvalidApiResponseError(`${fallbackMessage}（HTTP ${response.status || "未知"}，服务器没有返回内容）`, response.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const status = response.status || 0;
    const looksLikeHtml = /^\s*(?:<!doctype\s+html|<html\b)/i.test(text)
      || response.headers.get("content-type")?.toLocaleLowerCase().includes("text/html");
    const detail = looksLikeHtml
      ? "服务器返回了网页而不是接口数据"
      : "服务器返回了无法识别的数据";
    throw new InvalidApiResponseError(`${fallbackMessage}：${detail}（HTTP ${status || "未知"}）`, status);
  }
}
