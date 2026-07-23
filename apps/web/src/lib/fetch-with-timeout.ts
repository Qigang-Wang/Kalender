export const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

export class RequestTimeoutError extends Error {
  constructor() {
    super("请求超时，请检查电脑上的开发服务后重试");
    this.name = "RequestTimeoutError";
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
