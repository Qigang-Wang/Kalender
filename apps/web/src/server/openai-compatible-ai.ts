import type { AiModelCapabilities, AiProviderCredential, StoredAiModel, StoredAiProvider } from "./ai-provider-repository";
import { AiProviderError, assertAiEndpointAllowed, buildAiEndpoint, toAiPublicError } from "./ai-provider-validation";

export interface AiProviderConnectionInput {
  readonly baseUrl: string;
  readonly authScheme: "bearer" | "custom-header";
  readonly authHeaderName: string;
  readonly allowPrivateNetwork: boolean;
  readonly requestTimeoutMs: number;
}

export interface DiscoveredAiModel {
  readonly apiModelId: string;
  readonly displayName: string;
  readonly createdAt?: number;
  readonly owner?: string;
}

export interface AiProviderTestResult {
  readonly latencyMs: number;
  readonly models: readonly DiscoveredAiModel[];
}

export interface AiModelTestResult {
  readonly latencyMs: number;
  readonly capabilities: AiModelCapabilities;
}

export interface AiChatInputMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export type AiChatStreamPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "usage"; readonly promptTokens?: number; readonly completionTokens?: number };

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function testAiProviderConnection(
  provider: AiProviderConnectionInput,
  credential: AiProviderCredential,
): Promise<AiProviderTestResult> {
  const startedAt = performance.now();
  const models = await discoverAiModels(provider, credential);
  return { latencyMs: Math.max(0, Math.round(performance.now() - startedAt)), models };
}

export async function discoverAiModels(
  provider: AiProviderConnectionInput,
  credential: AiProviderCredential,
): Promise<readonly DiscoveredAiModel[]> {
  await assertAiEndpointAllowed(provider.baseUrl, provider.allowPrivateNetwork);
  const response = await aiFetch(
    buildAiEndpoint(provider.baseUrl, "models"),
    { method: "GET", headers: authHeaders(provider, credential) },
    provider.requestTimeoutMs,
  );
  const body = asRecord(await readJson(response));
  if (!Array.isArray(body.data)) throw new AiProviderError("das Modelllistenformat der AI API ist nicht kompatibel", "AI_MODELS_INVALID", 502);
  const seen = new Set<string>();
  return body.data.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim() || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{
      apiModelId: item.id,
      displayName: item.id,
      createdAt: typeof item.created === "number" ? item.created : undefined,
      owner: typeof item.owned_by === "string" ? item.owned_by : undefined,
    }];
  });
}

export async function testAiModelCapabilities(
  provider: AiProviderConnectionInput,
  credential: AiProviderCredential,
  model: Pick<StoredAiModel, "apiModelId" | "modelKind" | "endpointKind">,
): Promise<AiModelTestResult> {
  await assertAiEndpointAllowed(provider.baseUrl, provider.allowPrivateNetwork);
  const startedAt = performance.now();
  if (model.modelKind === "embedding" || model.endpointKind === "embeddings") {
    await postJson(provider, credential, "embeddings", { model: model.apiModelId, input: "Dayline capability test" });
    return {
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      capabilities: { embeddings: true },
    };
  }

  if (model.endpointKind === "responses") {
    await postJson(provider, credential, "responses", {
      model: model.apiModelId,
      input: "Reply with OK.",
      max_output_tokens: 16,
    });
    const streaming = await probe(() => postStream(provider, credential, "responses", {
      model: model.apiModelId,
      input: "Reply with OK.",
      max_output_tokens: 16,
      stream: true,
    }));
    return {
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      capabilities: { streaming, functionCalling: false },
    };
  }

  const messages = [
    { role: "system", content: "This is a connection test. Keep the answer short." },
    { role: "user", content: "Reply with OK." },
  ];
  await postJson(provider, credential, "chat/completions", {
    model: model.apiModelId,
    messages,
    max_tokens: 16,
    stream: false,
  });
  const streaming = await probe(() => postStream(provider, credential, "chat/completions", {
    model: model.apiModelId,
    messages,
    max_tokens: 16,
    stream: true,
  }));
  const functionCalling = await probe(async () => {
    const response = await postJson(provider, credential, "chat/completions", {
      model: model.apiModelId,
      messages: [{ role: "user", content: "Use the health_check tool." }],
      max_tokens: 32,
      tools: [{
        type: "function",
        function: {
          name: "health_check",
          description: "Checks whether tool calling works.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      }],
      tool_choice: { type: "function", function: { name: "health_check" } },
      stream: false,
    });
    if (!containsToolCall(response)) throw new AiProviderError("das Modell gab keinen Werkzeugaufruf zurück", "AI_TOOL_UNSUPPORTED", 502);
  });
  return {
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    capabilities: { streaming, functionCalling },
  };
}

export function storedProviderConnection(provider: StoredAiProvider): AiProviderConnectionInput {
  return {
    baseUrl: provider.baseUrl,
    authScheme: provider.authScheme,
    authHeaderName: provider.authHeaderName,
    allowPrivateNetwork: provider.allowPrivateNetwork,
    requestTimeoutMs: provider.requestTimeoutMs,
  };
}

export async function* streamAiChat(input: {
  readonly provider: AiProviderConnectionInput;
  readonly credential: AiProviderCredential;
  readonly model: Pick<StoredAiModel, "apiModelId" | "endpointKind" | "maxOutputTokens">;
  readonly messages: readonly AiChatInputMessage[];
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): AsyncGenerator<AiChatStreamPart> {
  await assertAiEndpointAllowed(input.provider.baseUrl, input.provider.allowPrivateNetwork);
  const endpoint = input.model.endpointKind === "responses" ? "responses" : "chat/completions";
  const body = endpoint === "responses"
    ? {
        model: input.model.apiModelId,
        input: input.messages.map((message) => ({ role: message.role, content: message.content })),
        ...(input.model.maxOutputTokens ? { max_output_tokens: input.model.maxOutputTokens } : {}),
        stream: true,
      }
    : {
        model: input.model.apiModelId,
        messages: input.messages,
        ...(input.model.maxOutputTokens ? { max_tokens: input.model.maxOutputTokens } : {}),
        stream: true,
      };
  const response = await aiFetchWithSignal(buildAiEndpoint(input.provider.baseUrl, endpoint), {
    method: "POST",
    headers: { ...authHeaders(input.provider, input.credential), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, input.signal, input.timeoutMs);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const json = await readJson(response);
    const text = extractCompleteText(json);
    if (!text) throw new AiProviderError("das Modell gibt keinen Textinhalt zurück", "AI_EMPTY_RESPONSE", 502);
    yield { type: "text", text };
    const usage = extractUsage(json);
    if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) yield { type: "usage", ...usage };
    return;
  }
  let receivedText = false;
  for await (const event of readSseEvents(response, MAX_RESPONSE_BYTES)) {
    if (event.data === "[DONE]") break;
    let payload: unknown;
    try { payload = JSON.parse(event.data) as unknown; } catch { continue; }
    const delta = extractStreamText(event.event, payload);
    if (delta) {
      receivedText = true;
      yield { type: "text", text: delta };
    }
    const usage = extractUsage(payload);
    if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) yield { type: "usage", ...usage };
  }
  if (!receivedText) throw new AiProviderError("das Modell gibt keinen Textinhalt zurück", "AI_EMPTY_RESPONSE", 502);
}

async function postJson(
  provider: AiProviderConnectionInput,
  credential: AiProviderCredential,
  endpoint: "chat/completions" | "responses" | "embeddings",
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await aiFetch(buildAiEndpoint(provider.baseUrl, endpoint), {
    method: "POST",
    headers: { ...authHeaders(provider, credential), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, provider.requestTimeoutMs);
  return readJson(response);
}

async function postStream(
  provider: AiProviderConnectionInput,
  credential: AiProviderCredential,
  endpoint: "chat/completions" | "responses",
  body: Record<string, unknown>,
): Promise<void> {
  const response = await aiFetch(buildAiEndpoint(provider.baseUrl, endpoint), {
    method: "POST",
    headers: { ...authHeaders(provider, credential), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, provider.requestTimeoutMs);
  const contentType = response.headers.get("content-type") ?? "";
  const text = await readTextLimited(response, 256 * 1024);
  if (!contentType.includes("text/event-stream") && !/^data:/m.test(text)) {
    throw new AiProviderError("Das Modell gibt keine Reaktion auf den Durchfluss zurück", "AI_STREAM_UNSUPPORTED", 502);
  }
}

async function aiFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (response.status >= 300 && response.status < 400) {
      throw new AiProviderError("AI API erlaubt keine Umleitung", "AI_REDIRECT_BLOCKED", 502);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw httpError(response.status);
    }
    return response;
  } catch (error) {
    throw toAiPublicError(error);
  }
}

async function aiFetchWithSignal(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new AiProviderError("AI API erlaubt keine Umleitung", "AI_REDIRECT_BLOCKED", 502);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw httpError(response.status);
    }
    return response;
  } catch (error) {
    throw toAiPublicError(error);
  }
}

function authHeaders(provider: AiProviderConnectionInput, credential: AiProviderCredential): Record<string, string> {
  return provider.authScheme === "bearer"
    ? { Authorization: `Bearer ${credential.apiKey}`, Accept: "application/json" }
    : { [provider.authHeaderName]: credential.apiKey, Accept: "application/json" };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await readTextLimited(response, MAX_RESPONSE_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AiProviderError("KI API lieferte ungeklärte Daten", "AI_RESPONSE_INVALID", 502);
  }
}

async function readTextLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new AiProviderError("die Daten, die von AI API zurückgegeben werden, sind zu groß", "AI_RESPONSE_TOO_LARGE", 502);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

async function* readSseEvents(response: Response, limit: number): AsyncGenerator<{ readonly event?: string; readonly data: string }> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new AiProviderError("die Daten, die von AI API zurückgegeben werden, sind zu groß", "AI_RESPONSE_TOO_LARGE", 502);
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block);
        if (event) yield event;
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    const final = parseSseBlock(buffer);
    if (final) yield final;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): { readonly event?: string; readonly data: string } | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join("\n") } : undefined;
}

function extractStreamText(event: string | undefined, value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const body = value as Record<string, unknown>;
  if ((event === "response.output_text.delta" || body.type === "response.output_text.delta") && typeof body.delta === "string") return body.delta;
  if (!Array.isArray(body.choices)) return "";
  for (const choice of body.choices) {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue;
    const delta = (choice as Record<string, unknown>).delta;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue;
    const content = (delta as Record<string, unknown>).content;
    if (typeof content === "string") return content;
  }
  return "";
}

function extractCompleteText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const body = value as Record<string, unknown>;
  if (typeof body.output_text === "string") return body.output_text;
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue;
      const message = (choice as Record<string, unknown>).message;
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") return content;
      }
    }
  }
  if (Array.isArray(body.output)) {
    const texts: string[] = [];
    for (const output of body.output) {
      if (!output || typeof output !== "object" || Array.isArray(output)) continue;
      const content = (output as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && !Array.isArray(part) && typeof (part as Record<string, unknown>).text === "string") {
          texts.push((part as Record<string, unknown>).text as string);
        }
      }
    }
    return texts.join("");
  }
  return "";
}

function extractUsage(value: unknown): { readonly promptTokens?: number; readonly completionTokens?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const body = value as Record<string, unknown>;
  const completedResponse = body.type === "response.completed" && body.response && typeof body.response === "object" && !Array.isArray(body.response)
    ? body.response as Record<string, unknown>
    : undefined;
  const usage = completedResponse?.usage ?? body.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const record = usage as Record<string, unknown>;
  const prompt = record.prompt_tokens ?? record.input_tokens;
  const completion = record.completion_tokens ?? record.output_tokens;
  return {
    promptTokens: typeof prompt === "number" && prompt >= 0 ? Math.round(prompt) : undefined,
    completionTokens: typeof completion === "number" && completion >= 0 ? Math.round(completion) : undefined,
  };
}

async function probe(action: () => Promise<unknown>): Promise<boolean> {
  try { await action(); return true; } catch { return false; }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiProviderError("KI API gibt inkompatibles Format zurück", "AI_RESPONSE_INVALID", 502);
  }
  return value as Record<string, unknown>;
}

function containsToolCall(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.choices)) return false;
  return body.choices.some((choice) => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) return false;
    const message = (choice as Record<string, unknown>).message;
    return Boolean(message && typeof message === "object" && !Array.isArray(message)
      && Array.isArray((message as Record<string, unknown>).tool_calls)
      && ((message as Record<string, unknown>).tool_calls as unknown[]).length);
  });
}

function httpError(status: number): AiProviderError {
  if (status === 401) return new AiProviderError("API Schlüssel ungültig oder Authentifizierung fehlgeschlagen", "AI_AUTH_FAILED", 401);
  if (status === 403) return new AiProviderError("AI API verweigert Zugriff, bitte überprüfen Sie die Berechtigungen", "AI_ACCESS_DENIED", 403);
  if (status === 404) return new AiProviderError("Die KI-API-Schnittstelle existiert nicht.", "AI_ENDPOINT_NOT_FOUND", 502);
  if (status === 429) return new AiProviderError("KI API erreicht derzeit Geschwindigkeit oder Grenze", "AI_RATE_LIMITED", 429);
  if (status >= 500) return new AiProviderError(`KI-API-Dienstanomalie (HTTP) ${status}）`, "AI_UPSTREAM_ERROR", 502);
  return new AiProviderError(`KI-API-Anfrage fehlgeschlagen (HTTP) ${status}）`, "AI_REQUEST_REJECTED", 502);
}
