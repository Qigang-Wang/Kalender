export const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

export class RequestTimeoutError extends Error {
  constructor() {
    super("Zeitüberschreitung der Anfrage. Bitte prüfen Sie den lokalen Dienst und versuchen Sie es erneut.");
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
    throw new InvalidApiResponseError(`${fallbackMessage} (HTTP ${response.status || "unbekannt"}: Der Server hat keinen Inhalt zurückgegeben)`, response.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const status = response.status || 0;
    const looksLikeHtml = /^\s*(?:<!doctype\s+html|<html\b)/i.test(text)
      || response.headers.get("content-type")?.toLocaleLowerCase().includes("text/html");
    const detail = looksLikeHtml
      ? "Der Server hat eine Webseite statt API-Daten zurückgegeben"
      : "Der Server hat nicht erkennbare Daten zurückgegeben";
    throw new InvalidApiResponseError(`${fallbackMessage}: ${detail} (HTTP ${status || "unbekannt"})`, status);
  }
}
