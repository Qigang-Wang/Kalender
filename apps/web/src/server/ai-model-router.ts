import {
  listAiFeatureBindings,
  listAiModels,
  listAiProviders,
  loadAiProviderCredential,
  type AiProviderCredential,
  type StoredAiModel,
  type StoredAiProvider,
} from "./ai-provider-repository";
import { AiProviderError, type AiFeatureKey } from "./ai-provider-validation";

export interface RoutedAiModel {
  readonly provider: StoredAiProvider;
  readonly model: StoredAiModel;
  readonly credential: AiProviderCredential;
}

export interface AiModelRoute {
  readonly featureKey: AiFeatureKey;
  readonly primary: RoutedAiModel;
  readonly fallback?: RoutedAiModel;
  readonly contextBudgetTokens: number;
  readonly timeoutMs: number;
}

export async function resolveAiModelRoute(input: {
  readonly featureKey: AiFeatureKey;
  readonly requestedModelId?: string;
}): Promise<AiModelRoute> {
  const [providers, models, bindings] = await Promise.all([
    listAiProviders(), listAiModels(), listAiFeatureBindings(),
  ]);
  const providerMap = new Map(providers.filter((provider) => provider.enabled && provider.hasApiKey).map((provider) => [provider.id, provider]));
  const eligible = models.filter((model) => model.enabled && model.modelKind === "chat" && providerMap.has(model.providerId));
  if (!eligible.length) {
    throw new AiProviderError("尚未配置可用的聊天模型，请先到“设置 → AI”添加并测试模型", "AI_MODEL_NOT_CONFIGURED", 409);
  }
  const binding = bindings.find((item) => item.featureKey === input.featureKey);
  const requested = input.requestedModelId
    ? eligible.find((model) => model.id === input.requestedModelId)
    : undefined;
  if (input.requestedModelId && !requested) {
    throw new AiProviderError("选择的 AI 模型不可用", "AI_MODEL_UNAVAILABLE", 409);
  }
  const boundPrimary = binding?.primaryModelId ? eligible.find((model) => model.id === binding.primaryModelId) : undefined;
  const primaryModel = requested ?? boundPrimary
    ?? eligible.find((model) => model.lastTestStatus === "passed")
    ?? eligible[0]!;
  const fallbackModel = binding?.fallbackModelId
    ? eligible.find((model) => model.id === binding.fallbackModelId && model.id !== primaryModel.id)
    : undefined;
  return {
    featureKey: input.featureKey,
    primary: await hydrate(primaryModel, providerMap),
    fallback: fallbackModel ? await hydrate(fallbackModel, providerMap) : undefined,
    contextBudgetTokens: binding?.contextBudgetTokens ?? 32_000,
    timeoutMs: binding?.timeoutMs ?? 60_000,
  };
}

async function hydrate(model: StoredAiModel, providerMap: ReadonlyMap<string, StoredAiProvider>): Promise<RoutedAiModel> {
  const provider = providerMap.get(model.providerId);
  if (!provider) throw new AiProviderError("AI API 当前不可用", "AI_PROVIDER_DISABLED", 409);
  return { provider, model, credential: await loadAiProviderCredential(provider.id) };
}
