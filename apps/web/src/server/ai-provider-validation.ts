import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AiProviderKind = "openai-compatible";
export type AiAuthScheme = "bearer" | "custom-header";
export type AiModelKind = "chat" | "embedding";
export type AiEndpointKind = "chat-completions" | "responses" | "embeddings";
export type AiToolMode = "none" | "read" | "write-proposals";

export const aiFeatureKeys = [
  "assistant.default",
  "assistant.planning",
  "mail.summarize",
  "mail.extract_actions",
  "mail.draft_reply",
  "notes.editor",
  "today.briefing",
  "search.embedding",
] as const;

export type AiFeatureKey = (typeof aiFeatureKeys)[number];

export interface ParsedAiProviderInput {
  readonly providerId?: string;
  readonly displayName: string;
  readonly providerKind: AiProviderKind;
  readonly baseUrl: string;
  readonly authScheme: AiAuthScheme;
  readonly authHeaderName: string;
  readonly apiKey?: string;
  readonly allowPrivateNetwork: boolean;
  readonly requestTimeoutMs: number;
  readonly enabled: boolean;
}

export interface ParsedAiModelInput {
  readonly modelId?: string;
  readonly providerId: string;
  readonly apiModelId: string;
  readonly displayName: string;
  readonly modelKind: AiModelKind;
  readonly endpointKind: AiEndpointKind;
  readonly enabled: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly dataRegion?: string;
}

export interface ParsedAiFeatureBindingInput {
  readonly featureKey: AiFeatureKey;
  readonly primaryModelId?: string;
  readonly fallbackModelId?: string;
  readonly contextBudgetTokens: number;
  readonly timeoutMs: number;
  readonly toolMode: AiToolMode;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly code = "AI_PROVIDER_ERROR",
    readonly status = 400,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export function parseAiProviderInput(value: unknown): ParsedAiProviderInput {
  const body = asRecord(value);
  const displayName = requiredText(body.displayName, "API-Name eingeben", 80);
  const providerKind: AiProviderKind = body.providerKind === undefined || body.providerKind === "openai-compatible"
    ? "openai-compatible"
    : invalid("Nur OpenAI-kompatible API wird derzeit unterstützt");
  const authScheme: AiAuthScheme = body.authScheme === "custom-header" ? "custom-header" : "bearer";
  const authHeaderName = authScheme === "bearer"
    ? "Authorization"
    : requiredText(body.authHeaderName, "Bitte geben Sie den Namen der Authentifizierung ein", 80);
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(authHeaderName)) {
    throw new AiProviderError("Authentifizierung Header-Name ungültig", "INVALID_AUTH_HEADER");
  }
  const allowPrivateNetwork = body.allowPrivateNetwork === true;
  const baseUrl = normalizeAiBaseUrl(requiredText(body.baseUrl, "API Base URL eingeben", 500), allowPrivateNetwork);
  const apiKey = optionalText(body.apiKey, 8192);
  const requestTimeoutMs = boundedInteger(body.requestTimeoutMs, 30_000, 1_000, 120_000, "Timeout anfordern");
  return {
    providerId: optionalId(body.providerId),
    displayName,
    providerKind,
    baseUrl,
    authScheme,
    authHeaderName,
    apiKey,
    allowPrivateNetwork,
    requestTimeoutMs,
    enabled: body.enabled !== false,
  };
}

export function parseAiModelInput(value: unknown, providerIdFromRoute?: string): ParsedAiModelInput {
  const body = asRecord(value);
  const providerId = providerIdFromRoute ?? requiredText(body.providerId, "Wählen Sie einen API-Anbieter", 100);
  const modelKind: AiModelKind = body.modelKind === "embedding" ? "embedding" : "chat";
  const endpointKind: AiEndpointKind = modelKind === "embedding"
    ? "embeddings"
    : body.endpointKind === "responses" ? "responses" : "chat-completions";
  const apiModelId = requiredText(body.apiModelId, "API-Modell-ID eingeben", 200);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:/+@-]*$/u.test(apiModelId)) {
    throw new AiProviderError("API-Modell-ID enthält nicht unterstützte Zeichen", "INVALID_MODEL_ID");
  }
  return {
    modelId: optionalId(body.modelId),
    providerId,
    apiModelId,
    displayName: optionalText(body.displayName, 120) ?? apiModelId,
    modelKind,
    endpointKind,
    enabled: body.enabled !== false,
    contextWindow: optionalPositiveInteger(body.contextWindow, 1_000_000, "Kontextlänge"),
    maxOutputTokens: optionalPositiveInteger(body.maxOutputTokens, 1_000_000, "maximale Ausgangslänge"),
    dataRegion: optionalText(body.dataRegion, 100),
  };
}

export function parseAiFeatureBindingInput(value: unknown): ParsedAiFeatureBindingInput {
  const body = asRecord(value);
  if (typeof body.featureKey !== "string" || !aiFeatureKeys.includes(body.featureKey as AiFeatureKey)) {
    throw new AiProviderError("der KI-Funktionsschlüssel ist ungültig", "INVALID_FEATURE_KEY");
  }
  const primaryModelId = optionalId(body.primaryModelId);
  const fallbackModelId = optionalId(body.fallbackModelId);
  if (primaryModelId && fallbackModelId === primaryModelId) {
    throw new AiProviderError("Das Hauptmodell und das Back-up-Modell können nicht identisch sein", "DUPLICATE_MODEL_BINDING");
  }
  const toolMode: AiToolMode = body.toolMode === "read" || body.toolMode === "write-proposals" ? body.toolMode : "none";
  return {
    featureKey: body.featureKey as AiFeatureKey,
    primaryModelId,
    fallbackModelId,
    contextBudgetTokens: boundedInteger(body.contextBudgetTokens, 32_000, 1_000, 1_000_000, "Kontexthaushalt"),
    timeoutMs: boundedInteger(body.timeoutMs, 60_000, 1_000, 180_000, "Modell-Timeout"),
    toolMode,
  };
}

export function normalizeAiBaseUrl(raw: string, allowPrivateNetwork: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiProviderError("API Base URL nicht gültig", "INVALID_BASE_URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AiProviderError("API Base URL kann nur HTTP oder HTTPS verwenden", "INVALID_BASE_URL");
  }
  if (url.protocol === "http:" && !allowPrivateNetwork) {
    throw new AiProviderError("öffentliches Netzwerk KI API muss HTTPS verwenden; lokale Dienste müssen explizit private Netzwerke zulassen", "INSECURE_BASE_URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AiProviderError("API Base URL kann keinen Benutzernamen, kein Passwort, keine Abfrageparameter oder Segmente enthalten", "INVALID_BASE_URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export async function assertAiEndpointAllowed(baseUrl: string, allowPrivateNetwork: boolean): Promise<void> {
  if (allowPrivateNetwork) return;
  const hostname = new URL(baseUrl).hostname;
  if (isPrivateHostname(hostname)) {
    throw new AiProviderError("KI-API-Adressen zu privaten Netzwerken; wenn Sie eine Verbindung zu lokalen Modellen herstellen möchten, aktivieren Sie bitte explizit den privaten Netzwerkzugriff.", "PRIVATE_NETWORK_BLOCKED");
  }
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
      throw new AiProviderError("KI-API-Domänenname parsed an private Netzwerkadresse", "PRIVATE_NETWORK_BLOCKED");
    }
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError("nicht in der Lage, AI API-Domänennamen zu parsen", "AI_HOST_LOOKUP_FAILED", 502);
  }
}

export function buildAiEndpoint(baseUrl: string, suffix: "models" | "chat/completions" | "responses" | "embeddings"): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix}`;
}

export function toAiPublicError(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AiProviderError("KI-API-Request-Timeout", "AI_TIMEOUT", 504);
  }
  if (error instanceof Error && /timeout|aborted/i.test(error.message)) {
    return new AiProviderError("KI-API-Request-Timeout", "AI_TIMEOUT", 504);
  }
  return new AiProviderError("AI API ist derzeit nicht verfügbar", "AI_PROVIDER_UNAVAILABLE", 502);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiProviderError("Ungültiges angefordertes Format", "INVALID_REQUEST");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, message: string, maxLength: number): string {
  const text = optionalText(value, maxLength);
  if (!text) throw new AiProviderError(message, "INVALID_REQUEST");
  return text;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new AiProviderError("Ungültiges Feldformat angefordert", "INVALID_REQUEST");
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new AiProviderError(`Inhalt der Eingabe darf nicht überschritten werden ${maxLength} ein Zeichen`, "INVALID_REQUEST");
  return text;
}

function optionalId(value: unknown): string | undefined {
  return optionalText(value, 100);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AiProviderError(`${label}muss ${min}–${max} Ganzzahl`, "INVALID_REQUEST");
  }
  return number;
}

function optionalPositiveInteger(value: unknown, max: number, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedInteger(value, 1, 1, max, label);
}

function invalid(message: string): never {
  throw new AiProviderError(message, "INVALID_REQUEST");
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") || (isIP(normalized) > 0 && isPrivateAddress(normalized));
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) !== 4) return false;
  const [a, b] = normalized.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}
