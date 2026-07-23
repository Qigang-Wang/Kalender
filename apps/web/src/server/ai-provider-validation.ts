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
  const displayName = requiredText(body.displayName, "请输入 API 名称", 80);
  const providerKind: AiProviderKind = body.providerKind === undefined || body.providerKind === "openai-compatible"
    ? "openai-compatible"
    : invalid("当前仅支持 OpenAI-compatible API");
  const authScheme: AiAuthScheme = body.authScheme === "custom-header" ? "custom-header" : "bearer";
  const authHeaderName = authScheme === "bearer"
    ? "Authorization"
    : requiredText(body.authHeaderName, "请输入认证 Header 名称", 80);
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(authHeaderName)) {
    throw new AiProviderError("认证 Header 名称无效", "INVALID_AUTH_HEADER");
  }
  const allowPrivateNetwork = body.allowPrivateNetwork === true;
  const baseUrl = normalizeAiBaseUrl(requiredText(body.baseUrl, "请输入 API Base URL", 500), allowPrivateNetwork);
  const apiKey = optionalText(body.apiKey, 8192);
  const requestTimeoutMs = boundedInteger(body.requestTimeoutMs, 30_000, 1_000, 120_000, "请求超时");
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
  const providerId = providerIdFromRoute ?? requiredText(body.providerId, "请选择 API 提供商", 100);
  const modelKind: AiModelKind = body.modelKind === "embedding" ? "embedding" : "chat";
  const endpointKind: AiEndpointKind = modelKind === "embedding"
    ? "embeddings"
    : body.endpointKind === "responses" ? "responses" : "chat-completions";
  const apiModelId = requiredText(body.apiModelId, "请输入 API model ID", 200);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:/+@-]*$/u.test(apiModelId)) {
    throw new AiProviderError("API model ID 包含不支持的字符", "INVALID_MODEL_ID");
  }
  return {
    modelId: optionalId(body.modelId),
    providerId,
    apiModelId,
    displayName: optionalText(body.displayName, 120) ?? apiModelId,
    modelKind,
    endpointKind,
    enabled: body.enabled !== false,
    contextWindow: optionalPositiveInteger(body.contextWindow, 1_000_000, "上下文长度"),
    maxOutputTokens: optionalPositiveInteger(body.maxOutputTokens, 1_000_000, "最大输出长度"),
    dataRegion: optionalText(body.dataRegion, 100),
  };
}

export function parseAiFeatureBindingInput(value: unknown): ParsedAiFeatureBindingInput {
  const body = asRecord(value);
  if (typeof body.featureKey !== "string" || !aiFeatureKeys.includes(body.featureKey as AiFeatureKey)) {
    throw new AiProviderError("AI 功能键无效", "INVALID_FEATURE_KEY");
  }
  const primaryModelId = optionalId(body.primaryModelId);
  const fallbackModelId = optionalId(body.fallbackModelId);
  if (primaryModelId && fallbackModelId === primaryModelId) {
    throw new AiProviderError("主模型和备用模型不能相同", "DUPLICATE_MODEL_BINDING");
  }
  const toolMode: AiToolMode = body.toolMode === "read" || body.toolMode === "write-proposals" ? body.toolMode : "none";
  return {
    featureKey: body.featureKey as AiFeatureKey,
    primaryModelId,
    fallbackModelId,
    contextBudgetTokens: boundedInteger(body.contextBudgetTokens, 32_000, 1_000, 1_000_000, "上下文预算"),
    timeoutMs: boundedInteger(body.timeoutMs, 60_000, 1_000, 180_000, "模型超时"),
    toolMode,
  };
}

export function normalizeAiBaseUrl(raw: string, allowPrivateNetwork: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiProviderError("API Base URL 格式无效", "INVALID_BASE_URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AiProviderError("API Base URL 只能使用 HTTP 或 HTTPS", "INVALID_BASE_URL");
  }
  if (url.protocol === "http:" && !allowPrivateNetwork) {
    throw new AiProviderError("公网 AI API 必须使用 HTTPS；本地服务需明确允许私有网络", "INSECURE_BASE_URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AiProviderError("API Base URL 不能包含用户名、密码、查询参数或片段", "INVALID_BASE_URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export async function assertAiEndpointAllowed(baseUrl: string, allowPrivateNetwork: boolean): Promise<void> {
  if (allowPrivateNetwork) return;
  const hostname = new URL(baseUrl).hostname;
  if (isPrivateHostname(hostname)) {
    throw new AiProviderError("AI API 地址指向私有网络；如需连接本地模型，请明确启用私有网络访问", "PRIVATE_NETWORK_BLOCKED");
  }
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
      throw new AiProviderError("AI API 域名解析到了私有网络地址", "PRIVATE_NETWORK_BLOCKED");
    }
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError("无法解析 AI API 域名", "AI_HOST_LOOKUP_FAILED", 502);
  }
}

export function buildAiEndpoint(baseUrl: string, suffix: "models" | "chat/completions" | "responses" | "embeddings"): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix}`;
}

export function toAiPublicError(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AiProviderError("AI API 请求超时", "AI_TIMEOUT", 504);
  }
  if (error instanceof Error && /timeout|aborted/i.test(error.message)) {
    return new AiProviderError("AI API 请求超时", "AI_TIMEOUT", 504);
  }
  return new AiProviderError("AI API 暂时不可用", "AI_PROVIDER_UNAVAILABLE", 502);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiProviderError("请求格式无效", "INVALID_REQUEST");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, message: string, maxLength: number): string {
  const text = optionalText(value, maxLength);
  if (!text) throw new AiProviderError(message, "INVALID_REQUEST");
  return text;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new AiProviderError("请求字段格式无效", "INVALID_REQUEST");
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new AiProviderError(`输入内容不能超过 ${maxLength} 个字符`, "INVALID_REQUEST");
  return text;
}

function optionalId(value: unknown): string | undefined {
  return optionalText(value, 100);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AiProviderError(`${label}必须是 ${min}–${max} 的整数`, "INVALID_REQUEST");
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
