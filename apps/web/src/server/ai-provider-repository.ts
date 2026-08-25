import { randomUUID } from "node:crypto";

import { decryptCredential, encryptCredential } from "./credential-crypto";
import { getDatabase } from "./database";
import { getUserScope } from "./user-scope";
import {
  AiProviderError,
  aiFeatureKeys,
  type AiAuthScheme,
  type AiEndpointKind,
  type AiFeatureKey,
  type AiModelKind,
  type AiProviderKind,
  type AiToolMode,
  type ParsedAiFeatureBindingInput,
  type ParsedAiModelInput,
  type ParsedAiProviderInput,
} from "./ai-provider-validation";

export interface AiProviderCredential {
  readonly apiKey: string;
}

export interface AiModelCapabilities {
  readonly streaming?: boolean;
  readonly functionCalling?: boolean;
  readonly structuredOutput?: boolean;
  readonly reasoning?: boolean;
  readonly embeddings?: boolean;
}

export interface StoredAiProvider {
  readonly id: string;
  readonly displayName: string;
  readonly providerKind: AiProviderKind;
  readonly baseUrl: string;
  readonly authScheme: AiAuthScheme;
  readonly authHeaderName: string;
  readonly enabled: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly requestTimeoutMs: number;
  readonly hasApiKey: boolean;
  readonly lastTestedAt?: string;
  readonly lastTestStatus: "untested" | "passed" | "failed";
  readonly lastTestLatencyMs?: number;
  readonly lastErrorCode?: string;
  readonly modelCount: number;
}

export interface StoredAiModel {
  readonly id: string;
  readonly providerId: string;
  readonly apiModelId: string;
  readonly displayName: string;
  readonly modelKind: AiModelKind;
  readonly endpointKind: AiEndpointKind;
  readonly enabled: boolean;
  readonly capabilities: AiModelCapabilities;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly dataRegion?: string;
  readonly lastTestedAt?: string;
  readonly lastTestStatus: "untested" | "passed" | "failed";
  readonly lastTestLatencyMs?: number;
  readonly lastErrorCode?: string;
}

export interface StoredAiFeatureBinding {
  readonly featureKey: AiFeatureKey;
  readonly primaryModelId?: string;
  readonly fallbackModelId?: string;
  readonly contextBudgetTokens: number;
  readonly timeoutMs: number;
  readonly toolMode: AiToolMode;
}

interface ProviderRow {
  id: string;
  display_name: string;
  provider_kind: AiProviderKind;
  base_url: string;
  auth_scheme: AiAuthScheme;
  auth_header_name: string;
  enabled: boolean;
  allow_private_network: boolean;
  request_timeout_ms: number;
  has_api_key: boolean;
  last_tested_at: string | null;
  last_test_status: StoredAiProvider["lastTestStatus"];
  last_test_latency_ms: number | null;
  last_error_code: string | null;
  model_count: number;
}

interface ModelRow {
  id: string;
  provider_id: string;
  api_model_id: string;
  display_name: string;
  model_kind: AiModelKind;
  endpoint_kind: AiEndpointKind;
  enabled: boolean;
  capabilities: AiModelCapabilities | string;
  context_window: number | null;
  max_output_tokens: number | null;
  data_region: string | null;
  last_tested_at: string | null;
  last_test_status: StoredAiModel["lastTestStatus"];
  last_test_latency_ms: number | null;
  last_error_code: string | null;
}

interface BindingRow {
  feature_key: AiFeatureKey;
  primary_model_id: string | null;
  fallback_model_id: string | null;
  context_budget_tokens: number;
  timeout_ms: number;
  tool_mode: AiToolMode;
}

const providerSelect = `
  SELECT p.id, p.display_name, p.provider_kind, p.base_url, p.auth_scheme,
         p.auth_header_name, p.enabled, p.allow_private_network, p.request_timeout_ms,
         EXISTS (SELECT 1 FROM ai_provider_credentials c WHERE c.provider_id = p.id) AS has_api_key,
         p.last_tested_at, p.last_test_status, p.last_test_latency_ms, p.last_error_code,
         COUNT(m.id)::integer AS model_count
    FROM ai_providers p
    LEFT JOIN ai_models m ON m.provider_id = p.id`;

const modelSelect = `
  SELECT id, provider_id, api_model_id, display_name, model_kind, endpoint_kind,
         enabled, capabilities, context_window, max_output_tokens, data_region,
         last_tested_at, last_test_status, last_test_latency_ms, last_error_code
    FROM ai_models`;

export async function listAiProviders(): Promise<readonly StoredAiProvider[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<ProviderRow>(`${providerSelect}
    ${scope.active ? "WHERE p.user_id = $1" : ""}
    GROUP BY p.id
    ORDER BY p.created_at`, scope.active ? [scope.userId] : []);
  return result.rows.map(mapProvider);
}

export async function getAiProvider(id: string): Promise<StoredAiProvider | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<ProviderRow>(`${providerSelect}
    WHERE p.id = $1${scope.active ? " AND p.user_id = $2" : ""}
    GROUP BY p.id
    LIMIT 1`, scope.active ? [id, scope.userId] : [id]);
  return result.rows[0] ? mapProvider(result.rows[0]) : undefined;
}

export async function saveAiProvider(input: ParsedAiProviderInput): Promise<StoredAiProvider> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const providerId = input.providerId ?? randomUUID();
  const existing = input.providerId ? await getAiProvider(input.providerId) : undefined;
  if (input.providerId && !existing) throw new AiProviderError("KI-API existiert nicht", "AI_PROVIDER_NOT_FOUND", 404);
  if (!input.apiKey && !existing?.hasApiKey) throw new AiProviderError("API-Schlüssel eingeben", "AI_API_KEY_REQUIRED");
  const encryptedPayload = input.apiKey
    ? await encryptCredential(`ai-provider:${providerId}`, { apiKey: input.apiKey } satisfies AiProviderCredential)
    : undefined;
  try {
    await database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO ai_providers (
           id, user_id, display_name, provider_kind, base_url, auth_scheme, auth_header_name,
           enabled, allow_private_network, request_timeout_ms, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           provider_kind = EXCLUDED.provider_kind,
           base_url = EXCLUDED.base_url,
           auth_scheme = EXCLUDED.auth_scheme,
           auth_header_name = EXCLUDED.auth_header_name,
           enabled = EXCLUDED.enabled,
           allow_private_network = EXCLUDED.allow_private_network,
           request_timeout_ms = EXCLUDED.request_timeout_ms,
           updated_at = now()`,
        [providerId, scope.valueOrNull(), input.displayName, input.providerKind, input.baseUrl, input.authScheme,
          input.authHeaderName, input.enabled, input.allowPrivateNetwork, input.requestTimeoutMs],
      );
      if (encryptedPayload) {
        await transaction.query(
          `INSERT INTO ai_provider_credentials (provider_id, encrypted_payload, key_version, updated_at)
           VALUES ($1, $2, 1, now())
           ON CONFLICT (provider_id) DO UPDATE SET
             encrypted_payload = EXCLUDED.encrypted_payload,
             key_version = 1,
             updated_at = now()`,
          [providerId, encryptedPayload],
        );
      }
    });
  } catch (error) {
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
      throw new AiProviderError("API-Name existiert bereits", "AI_PROVIDER_NAME_EXISTS", 409);
    }
    throw error;
  }
  return (await getAiProvider(providerId))!;
}

export async function loadAiProviderCredential(providerId: string): Promise<AiProviderCredential> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<{ encrypted_payload: string }>(
    `SELECT c.encrypted_payload
       FROM ai_provider_credentials c
       JOIN ai_providers p ON p.id = c.provider_id
      WHERE c.provider_id = $1${scope.active ? " AND p.user_id = $2" : ""}
      LIMIT 1`,
    scope.active ? [providerId, scope.userId] : [providerId],
  );
  const payload = result.rows[0]?.encrypted_payload;
  if (!payload) throw new AiProviderError("API-Schlüssel existiert nicht", "AI_API_KEY_NOT_FOUND", 404);
  return decryptCredential<AiProviderCredential>(`ai-provider:${providerId}`, payload);
}

export async function deleteAiProvider(providerId: string): Promise<boolean> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query(
    `DELETE FROM ai_providers WHERE id = $1${scope.active ? " AND user_id = $2" : ""}`,
    scope.active ? [providerId, scope.userId] : [providerId],
  );
  return (result.affectedRows ?? 0) > 0;
}

export async function updateAiProviderTestStatus(
  providerId: string,
  result: { readonly status: "passed" | "failed"; readonly latencyMs?: number; readonly errorCode?: string },
): Promise<void> {
  const database = await getDatabase();
  const scope = await getUserScope();
  await database.query(
    `UPDATE ai_providers SET last_tested_at = now(), last_test_status = $2,
       last_test_latency_ms = $3, last_error_code = $4, updated_at = now() WHERE id = $1${scope.active ? " AND user_id = $5" : ""}`,
    scope.active ? [providerId, result.status, result.latencyMs ?? null, result.errorCode ?? null, scope.userId] : [providerId, result.status, result.latencyMs ?? null, result.errorCode ?? null],
  );
}

export async function listAiModels(providerId?: string): Promise<readonly StoredAiModel[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = providerId
    ? await database.query<ModelRow>(
        `${modelSelect} WHERE provider_id = $1${scope.active ? " AND provider_id IN (SELECT id FROM ai_providers WHERE user_id = $2)" : ""} ORDER BY created_at`,
        scope.active ? [providerId, scope.userId] : [providerId],
      )
    : await database.query<ModelRow>(
        `${modelSelect}${scope.active ? " WHERE provider_id IN (SELECT id FROM ai_providers WHERE user_id = $1)" : ""} ORDER BY created_at`,
        scope.active ? [scope.userId] : [],
      );
  return result.rows.map(mapModel);
}

export async function getAiModel(id: string): Promise<StoredAiModel | undefined> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<ModelRow>(
    `${modelSelect} WHERE id = $1${scope.active ? " AND provider_id IN (SELECT id FROM ai_providers WHERE user_id = $2)" : ""} LIMIT 1`,
    scope.active ? [id, scope.userId] : [id],
  );
  return result.rows[0] ? mapModel(result.rows[0]) : undefined;
}

export async function saveAiModel(
  input: ParsedAiModelInput,
  test?: { readonly capabilities?: AiModelCapabilities; readonly latencyMs?: number },
): Promise<StoredAiModel> {
  const database = await getDatabase();
  if (!await getAiProvider(input.providerId)) throw new AiProviderError("KI-API existiert nicht", "AI_PROVIDER_NOT_FOUND", 404);
  const modelId = input.modelId ?? randomUUID();
  if (input.modelId && !await getAiModel(input.modelId)) throw new AiProviderError("Das KI-Modell existiert nicht", "AI_MODEL_NOT_FOUND", 404);
  try {
    await database.query(
      `INSERT INTO ai_models (
         id, provider_id, api_model_id, display_name, model_kind, endpoint_kind, enabled,
         capabilities, context_window, max_output_tokens, data_region,
         last_tested_at, last_test_status, last_test_latency_ms, last_error_code, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11,
         ${test ? "now(), 'passed', $12, NULL" : "NULL, 'untested', NULL, NULL"}, now())
       ON CONFLICT (id) DO UPDATE SET
         api_model_id = EXCLUDED.api_model_id,
         display_name = EXCLUDED.display_name,
         model_kind = EXCLUDED.model_kind,
         endpoint_kind = EXCLUDED.endpoint_kind,
         enabled = EXCLUDED.enabled,
         capabilities = EXCLUDED.capabilities,
         context_window = EXCLUDED.context_window,
         max_output_tokens = EXCLUDED.max_output_tokens,
         data_region = EXCLUDED.data_region,
         last_tested_at = EXCLUDED.last_tested_at,
         last_test_status = EXCLUDED.last_test_status,
         last_test_latency_ms = EXCLUDED.last_test_latency_ms,
         last_error_code = EXCLUDED.last_error_code,
         updated_at = now()`,
      [modelId, input.providerId, input.apiModelId, input.displayName, input.modelKind, input.endpointKind,
        input.enabled, JSON.stringify(test?.capabilities ?? {}), input.contextWindow ?? null,
        input.maxOutputTokens ?? null, input.dataRegion ?? null, ...(test ? [test.latencyMs ?? null] : [])],
    );
  } catch (error) {
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
      throw new AiProviderError("diese API-Modell-ID wurde hinzugefügt", "AI_MODEL_EXISTS", 409);
    }
    throw error;
  }
  return (await getAiModel(modelId))!;
}

export async function updateAiModelTestStatus(
  modelId: string,
  result: { readonly status: "passed" | "failed"; readonly capabilities?: AiModelCapabilities; readonly latencyMs?: number; readonly errorCode?: string },
): Promise<void> {
  const database = await getDatabase();
  const scope = await getUserScope();
  await database.query(
    `UPDATE ai_models SET last_tested_at = now(), last_test_status = $2,
       capabilities = COALESCE($3::jsonb, capabilities), last_test_latency_ms = $4,
       last_error_code = $5, updated_at = now() WHERE id = $1${scope.active ? " AND provider_id IN (SELECT id FROM ai_providers WHERE user_id = $6)" : ""}`,
    scope.active
      ? [modelId, result.status, result.capabilities ? JSON.stringify(result.capabilities) : null, result.latencyMs ?? null, result.errorCode ?? null, scope.userId]
      : [modelId, result.status, result.capabilities ? JSON.stringify(result.capabilities) : null, result.latencyMs ?? null, result.errorCode ?? null],
  );
}

export async function deleteAiModel(modelId: string): Promise<boolean> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query(
    `DELETE FROM ai_models WHERE id = $1${scope.active ? " AND provider_id IN (SELECT id FROM ai_providers WHERE user_id = $2)" : ""}`,
    scope.active ? [modelId, scope.userId] : [modelId],
  );
  return (result.affectedRows ?? 0) > 0;
}

export async function listAiFeatureBindings(): Promise<readonly StoredAiFeatureBinding[]> {
  const database = await getDatabase();
  const scope = await getUserScope();
  const result = await database.query<BindingRow>(
    `SELECT feature_key, primary_model_id, fallback_model_id, context_budget_tokens, timeout_ms, tool_mode
       FROM ai_feature_bindings${scope.active ? " WHERE user_id = $1" : ""}`,
    scope.active ? [scope.userId] : [],
  );
  const stored = new Map(result.rows.map((row) => [row.feature_key, mapBinding(row)]));
  return aiFeatureKeys.map((featureKey) => stored.get(featureKey) ?? {
    featureKey,
    contextBudgetTokens: 32_000,
    timeoutMs: 60_000,
    toolMode: "none" as const,
  });
}

export async function saveAiFeatureBinding(input: ParsedAiFeatureBindingInput): Promise<StoredAiFeatureBinding> {
  const database = await getDatabase();
  const scope = await getUserScope();
  if (input.primaryModelId && !await getAiModel(input.primaryModelId)) {
    throw new AiProviderError("Das Hauptmodell existiert nicht", "AI_MODEL_NOT_FOUND", 404);
  }
  if (input.fallbackModelId && !await getAiModel(input.fallbackModelId)) {
    throw new AiProviderError("das Backup-Modell existiert nicht", "AI_MODEL_NOT_FOUND", 404);
  }
  if (!scope.active) {
    await database.query("DELETE FROM ai_feature_bindings WHERE user_id IS NULL AND feature_key = $1", [input.featureKey]);
  }
  await database.query(
    `INSERT INTO ai_feature_bindings (
       user_id, feature_key, primary_model_id, fallback_model_id, context_budget_tokens, timeout_ms, tool_mode, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (user_id, feature_key) DO UPDATE SET
       primary_model_id = EXCLUDED.primary_model_id,
       fallback_model_id = EXCLUDED.fallback_model_id,
       context_budget_tokens = EXCLUDED.context_budget_tokens,
       timeout_ms = EXCLUDED.timeout_ms,
       tool_mode = EXCLUDED.tool_mode,
       updated_at = now()`,
    [scope.valueOrNull(), input.featureKey, input.primaryModelId ?? null, input.fallbackModelId ?? null,
      input.contextBudgetTokens, input.timeoutMs, input.toolMode],
  );
  return input;
}

function mapProvider(row: ProviderRow): StoredAiProvider {
  return {
    id: row.id,
    displayName: row.display_name,
    providerKind: row.provider_kind,
    baseUrl: row.base_url,
    authScheme: row.auth_scheme,
    authHeaderName: row.auth_header_name,
    enabled: row.enabled,
    allowPrivateNetwork: row.allow_private_network,
    requestTimeoutMs: Number(row.request_timeout_ms),
    hasApiKey: row.has_api_key,
    lastTestedAt: row.last_tested_at ?? undefined,
    lastTestStatus: row.last_test_status,
    lastTestLatencyMs: row.last_test_latency_ms ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    modelCount: Number(row.model_count),
  };
}

function mapModel(row: ModelRow): StoredAiModel {
  return {
    id: row.id,
    providerId: row.provider_id,
    apiModelId: row.api_model_id,
    displayName: row.display_name,
    modelKind: row.model_kind,
    endpointKind: row.endpoint_kind,
    enabled: row.enabled,
    capabilities: typeof row.capabilities === "string" ? JSON.parse(row.capabilities) as AiModelCapabilities : row.capabilities,
    contextWindow: row.context_window ?? undefined,
    maxOutputTokens: row.max_output_tokens ?? undefined,
    dataRegion: row.data_region ?? undefined,
    lastTestedAt: row.last_tested_at ?? undefined,
    lastTestStatus: row.last_test_status,
    lastTestLatencyMs: row.last_test_latency_ms ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
  };
}

function mapBinding(row: BindingRow): StoredAiFeatureBinding {
  return {
    featureKey: row.feature_key,
    primaryModelId: row.primary_model_id ?? undefined,
    fallbackModelId: row.fallback_model_id ?? undefined,
    contextBudgetTokens: Number(row.context_budget_tokens),
    timeoutMs: Number(row.timeout_ms),
    toolMode: row.tool_mode,
  };
}
