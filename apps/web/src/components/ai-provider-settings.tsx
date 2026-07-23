"use client";

import {
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface AiProviderView {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authScheme: "bearer" | "custom-header";
  readonly authHeaderName: string;
  readonly enabled: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly requestTimeoutMs: number;
  readonly hasApiKey: boolean;
  readonly lastTestStatus: "untested" | "passed" | "failed";
  readonly lastTestLatencyMs?: number;
  readonly modelCount: number;
}

interface AiModelView {
  readonly id: string;
  readonly providerId: string;
  readonly apiModelId: string;
  readonly displayName: string;
  readonly modelKind: "chat" | "embedding";
  readonly endpointKind: "chat-completions" | "responses" | "embeddings";
  readonly enabled: boolean;
  readonly capabilities: { readonly streaming?: boolean; readonly functionCalling?: boolean; readonly embeddings?: boolean };
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly dataRegion?: string;
  readonly lastTestStatus: "untested" | "passed" | "failed";
  readonly lastTestLatencyMs?: number;
}

type FeatureKey = "assistant.default" | "assistant.planning" | "mail.summarize" | "mail.extract_actions" | "mail.draft_reply" | "notes.editor" | "today.briefing" | "search.embedding";

interface AiBindingView {
  readonly featureKey: FeatureKey;
  readonly primaryModelId?: string;
  readonly fallbackModelId?: string;
  readonly contextBudgetTokens: number;
  readonly timeoutMs: number;
  readonly toolMode: "none" | "read" | "write-proposals";
}

interface DiscoveredModel { readonly apiModelId: string; readonly displayName: string; readonly owner?: string }

interface ProviderFormState {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  authScheme: "bearer" | "custom-header";
  authHeaderName: string;
  allowPrivateNetwork: boolean;
  requestTimeoutMs: number;
  enabled: boolean;
}

interface ModelFormState {
  providerId: string;
  apiModelId: string;
  displayName: string;
  modelKind: "chat" | "embedding";
  endpointKind: "chat-completions" | "responses" | "embeddings";
  contextWindow: string;
  maxOutputTokens: string;
  dataRegion: string;
  enabled: boolean;
}

const featureLabels: Record<FeatureKey, { readonly title: string; readonly detail: string }> = {
  "assistant.default": { title: "AI Command 默认", detail: "通用问答与工作区助手" },
  "assistant.planning": { title: "复杂规划", detail: "跨邮件、日历与任务的计划" },
  "mail.summarize": { title: "邮件摘要", detail: "长邮件与会话压缩" },
  "mail.extract_actions": { title: "邮件行动项", detail: "识别截止时间和待办" },
  "mail.draft_reply": { title: "邮件回复草稿", detail: "只生成草稿，不自动发送" },
  "notes.editor": { title: "笔记编辑", detail: "改写、整理和补全" },
  "today.briefing": { title: "每日简报", detail: "汇总当天重要信息" },
  "search.embedding": { title: "语义搜索", detail: "仅可选择 Embedding 模型" },
};

const emptyProviderForm: ProviderFormState = {
  displayName: "KI Connect",
  baseUrl: "https://chat.kiconnect.nrw/api/v1",
  apiKey: "",
  authScheme: "bearer",
  authHeaderName: "Authorization",
  allowPrivateNetwork: false,
  requestTimeoutMs: 30_000,
  enabled: true,
};

const emptyModelForm: ModelFormState = {
  providerId: "",
  apiModelId: "",
  displayName: "",
  modelKind: "chat",
  endpointKind: "chat-completions",
  contextWindow: "",
  maxOutputTokens: "",
  dataRegion: "",
  enabled: true,
};

export function AiProviderSettings() {
  const [providers, setProviders] = useState<readonly AiProviderView[]>([]);
  const [models, setModels] = useState<readonly AiModelView[]>([]);
  const [bindings, setBindings] = useState<readonly AiBindingView[]>([]);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<string>();
  const [feedback, setFeedback] = useState<{ readonly kind: "success" | "error" | "info"; readonly message: string }>();
  const [providerForm, setProviderForm] = useState(emptyProviderForm);
  const [editingProviderId, setEditingProviderId] = useState<string>();
  const [showApiKey, setShowApiKey] = useState(false);
  const [discovered, setDiscovered] = useState<Record<string, readonly DiscoveredModel[]>>({});
  const [modelForm, setModelForm] = useState(emptyModelForm);

  const load = useCallback(async () => {
    try {
      const payload = await requestJson<{ providers: readonly AiProviderView[]; models: readonly AiModelView[]; bindings: readonly AiBindingView[] }>("/api/ai/providers");
      setProviders(payload.providers);
      setModels(payload.models);
      setBindings(payload.bindings);
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const providerPayload = () => ({
    ...providerForm,
    providerId: editingProviderId,
    providerKind: "openai-compatible",
    apiKey: providerForm.apiKey || undefined,
  });

  const testProvider = async () => {
    setOperation("provider-test");
    setFeedback({ kind: "info", message: "正在验证认证并读取模型列表…" });
    try {
      const payload = await requestJson<{ message: string; latencyMs: number; discoveredModels: readonly DiscoveredModel[] }>(
        "/api/ai/providers/test", { method: "POST", body: JSON.stringify(providerPayload()) },
      );
      setDiscovered((current) => ({ ...current, [editingProviderId ?? "draft"]: payload.discoveredModels }));
      setFeedback({ kind: "success", message: `${payload.message} · ${payload.latencyMs} ms` });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally { setOperation(undefined); }
  };

  const saveProvider = async () => {
    setOperation("provider-save");
    setFeedback({ kind: "info", message: "保存前正在重新测试连接…" });
    try {
      const path = editingProviderId ? `/api/ai/providers/${editingProviderId}` : "/api/ai/providers";
      const payload = await requestJson<{ provider: AiProviderView; discoveredModels: readonly DiscoveredModel[] }>(path, {
        method: editingProviderId ? "PATCH" : "POST",
        body: JSON.stringify(providerPayload()),
      });
      setDiscovered((current) => ({ ...current, [payload.provider.id]: payload.discoveredModels }));
      setFeedback({ kind: "success", message: `“${payload.provider.displayName}”已安全保存，API Key 不会返回浏览器` });
      resetProviderForm();
      await load();
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally { setOperation(undefined); }
  };

  const editProvider = (provider: AiProviderView) => {
    setEditingProviderId(provider.id);
    setProviderForm({
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      apiKey: "",
      authScheme: provider.authScheme,
      authHeaderName: provider.authHeaderName,
      allowPrivateNetwork: provider.allowPrivateNetwork,
      requestTimeoutMs: provider.requestTimeoutMs,
      enabled: provider.enabled,
    });
    setFeedback(undefined);
  };

  const resetProviderForm = () => {
    setEditingProviderId(undefined);
    setProviderForm(emptyProviderForm);
    setShowApiKey(false);
  };

  const removeProvider = async (provider: AiProviderView) => {
    if (!window.confirm(`删除“${provider.displayName}”及其所有模型配置？`)) return;
    setOperation(`delete-provider:${provider.id}`);
    try {
      await requestJson(`/api/ai/providers/${provider.id}`, { method: "DELETE" });
      if (editingProviderId === provider.id) resetProviderForm();
      setFeedback({ kind: "success", message: `“${provider.displayName}”已删除` });
      await load();
    } catch (error) { setFeedback({ kind: "error", message: errorMessage(error) }); }
    finally { setOperation(undefined); }
  };

  const discoverModels = async (provider: AiProviderView) => {
    setOperation(`discover:${provider.id}`);
    try {
      const payload = await requestJson<{ models: readonly DiscoveredModel[] }>(`/api/ai/providers/${provider.id}/models/discover`, { method: "POST" });
      setDiscovered((current) => ({ ...current, [provider.id]: payload.models }));
      setModelForm((current) => ({ ...current, providerId: provider.id }));
      setFeedback({ kind: "success", message: `发现 ${payload.models.length} 个模型，请选择需要使用的模型添加` });
    } catch (error) { setFeedback({ kind: "error", message: errorMessage(error) }); }
    finally { setOperation(undefined); }
  };

  const selectDiscoveredModel = (providerId: string, apiModelId: string) => {
    setModelForm({
      ...emptyModelForm,
      providerId,
      apiModelId,
      displayName: apiModelId,
      modelKind: apiModelId.toLowerCase().includes("embed") ? "embedding" : "chat",
      endpointKind: apiModelId.toLowerCase().includes("embed") ? "embeddings" : "chat-completions",
    });
  };

  const saveModel = async () => {
    if (!modelForm.providerId) return;
    setOperation("model-save");
    setFeedback({ kind: "info", message: "正在调用模型并探测流式输出与工具调用能力…" });
    try {
      const payload = await requestJson<{ model: AiModelView }>(`/api/ai/providers/${modelForm.providerId}/models`, {
        method: "POST",
        body: JSON.stringify({
          ...modelForm,
          displayName: modelForm.displayName || modelForm.apiModelId,
          contextWindow: modelForm.contextWindow || undefined,
          maxOutputTokens: modelForm.maxOutputTokens || undefined,
          dataRegion: modelForm.dataRegion || undefined,
        }),
      });
      setFeedback({ kind: "success", message: `模型“${payload.model.displayName}”已添加并通过基础调用测试` });
      setModelForm({ ...emptyModelForm, providerId: modelForm.providerId });
      await load();
    } catch (error) { setFeedback({ kind: "error", message: errorMessage(error) }); }
    finally { setOperation(undefined); }
  };

  const testModel = async (model: AiModelView) => {
    setOperation(`test-model:${model.id}`);
    try {
      const payload = await requestJson<{ model: AiModelView }>(`/api/ai/models/${model.id}/test`, { method: "POST" });
      setFeedback({ kind: "success", message: `“${payload.model.displayName}”测试通过 · ${payload.model.lastTestLatencyMs ?? 0} ms` });
      await load();
    } catch (error) { setFeedback({ kind: "error", message: errorMessage(error) }); }
    finally { setOperation(undefined); }
  };

  const removeModel = async (model: AiModelView) => {
    if (!window.confirm(`删除模型“${model.displayName}”？相关功能绑定会自动清空。`)) return;
    setOperation(`delete-model:${model.id}`);
    try {
      await requestJson(`/api/ai/models/${model.id}`, { method: "DELETE" });
      setFeedback({ kind: "success", message: `模型“${model.displayName}”已删除` });
      await load();
    } catch (error) { setFeedback({ kind: "error", message: errorMessage(error) }); }
    finally { setOperation(undefined); }
  };

  const updateBinding = (featureKey: FeatureKey, field: "primaryModelId" | "fallbackModelId", value: string) => {
    setBindings((current) => current.map((binding) => binding.featureKey === featureKey
      ? { ...binding, [field]: value || undefined }
      : binding));
  };

  const saveBindings = async () => {
    setOperation("bindings-save");
    try {
      await requestJson("/api/ai/feature-bindings", { method: "PUT", body: JSON.stringify(bindings) });
      setFeedback({ kind: "success", message: "功能模型分配已保存" });
      await load();
    } catch (error) { setFeedback({ kind: "error", message: errorMessage(error) }); }
    finally { setOperation(undefined); }
  };

  const modelsByProvider = useMemo(() => new Map(providers.map((provider) => [
    provider.id, models.filter((model) => model.providerId === provider.id),
  ])), [models, providers]);

  return (
    <section className="panel ai-provider-settings">
      <header className="ai-settings-header">
        <div className="assistant-icon"><Bot size={18} /></div>
        <div><h2>AI API 与模型</h2><p>配置 OpenAI-compatible API；一个 API 可以添加多个模型，并按功能分别使用。</p></div>
        <span className="step-badge">阶段 1 · 接入底座</span>
      </header>

      {feedback && <div className={`ai-settings-feedback ${feedback.kind}`} role="status">
        {feedback.kind === "success" ? <CheckCircle2 size={15} /> : feedback.kind === "error" ? <CircleAlert size={15} /> : <LoaderCircle className={operation ? "spin" : ""} size={15} />}
        <span>{feedback.message}</span><button aria-label="关闭提示" onClick={() => setFeedback(undefined)}><X size={13} /></button>
      </div>}

      <div className="ai-settings-section-title"><Server size={15} /><div><h3>{editingProviderId ? "编辑 API" : "连接新的 API"}</h3><p>保存时必须通过连接测试；留空密钥表示保留原密钥。</p></div></div>
      <div className="ai-provider-form">
        <label><span>API 名称</span><input value={providerForm.displayName} onChange={(event) => setProviderForm({ ...providerForm, displayName: event.target.value })} placeholder="例如 KI Connect" /></label>
        <label className="wide"><span>API Base URL</span><input value={providerForm.baseUrl} onChange={(event) => setProviderForm({ ...providerForm, baseUrl: event.target.value })} placeholder="https://…/v1" inputMode="url" /></label>
        <label className="wide"><span>API Key {editingProviderId && <small>（留空则不修改）</small>}</span><div className="ai-secret-input"><KeyRound size={14} /><input type={showApiKey ? "text" : "password"} autoComplete="new-password" value={providerForm.apiKey} onChange={(event) => setProviderForm({ ...providerForm, apiKey: event.target.value })} placeholder={editingProviderId ? "已安全保存" : "输入 API Key"} /><button aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"} onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
        <label><span>认证方式</span><select value={providerForm.authScheme} onChange={(event) => setProviderForm({ ...providerForm, authScheme: event.target.value as "bearer" | "custom-header" })}><option value="bearer">Bearer Token</option><option value="custom-header">自定义 Header</option></select></label>
        {providerForm.authScheme === "custom-header" && <label><span>Header 名称</span><input value={providerForm.authHeaderName} onChange={(event) => setProviderForm({ ...providerForm, authHeaderName: event.target.value })} placeholder="api-key" /></label>}
        <label><span>超时（秒）</span><input type="number" min="1" max="120" value={providerForm.requestTimeoutMs / 1000} onChange={(event) => setProviderForm({ ...providerForm, requestTimeoutMs: Number(event.target.value) * 1000 })} /></label>
        <label className="ai-checkbox-label"><input type="checkbox" checked={providerForm.allowPrivateNetwork} onChange={(event) => setProviderForm({ ...providerForm, allowPrivateNetwork: event.target.checked })} /><span>允许连接本机/私有网络模型</span></label>
      </div>
      <div className="ai-form-actions">
        <button className="secondary-button" disabled={Boolean(operation) || !providerForm.baseUrl} onClick={() => void testProvider()}>{operation === "provider-test" ? <LoaderCircle className="spin" size={14} /> : <Zap size={14} />}测试连接</button>
        <button className="primary-button" disabled={Boolean(operation) || !providerForm.baseUrl || (!editingProviderId && !providerForm.apiKey)} onClick={() => void saveProvider()}>{operation === "provider-save" && <LoaderCircle className="spin" size={14} />}{editingProviderId ? "保存修改" : "测试并保存"}</button>
        {editingProviderId && <button className="quiet-button" onClick={resetProviderForm}>取消编辑</button>}
      </div>

      <div className="ai-divider" />
      <div className="ai-settings-section-title"><Bot size={15} /><div><h3>已连接 API 与模型</h3><p>只添加实际要使用的模型，避免模型列表变得混乱。</p></div><span>{providers.length} 个 API · {models.length} 个模型</span></div>
      {loading ? <div className="ai-settings-empty"><LoaderCircle className="spin" size={18} />正在读取配置…</div> : providers.length === 0 ? <div className="ai-settings-empty"><Server size={20} /><strong>尚未连接 AI API</strong><span>填写上方信息并通过测试后即可保存。</span></div> : <div className="ai-provider-list">
        {providers.map((provider) => <article className="ai-provider-card" key={provider.id}>
          <header><div className="ai-provider-symbol"><Server size={16} /></div><div><h4>{provider.displayName}</h4><p>{provider.baseUrl}</p></div><StatusBadge status={provider.lastTestStatus} latency={provider.lastTestLatencyMs} /><button title="编辑" onClick={() => editProvider(provider)}><Pencil size={14} /></button><button className="danger" title="删除" disabled={Boolean(operation)} onClick={() => void removeProvider(provider)}><Trash2 size={14} /></button></header>
          <div className="ai-provider-meta"><span><ShieldCheck size={12} />Key 已加密</span><span>{provider.authScheme === "bearer" ? "Bearer" : provider.authHeaderName}</span><span>{provider.modelCount} 个模型</span><button disabled={Boolean(operation)} onClick={() => void discoverModels(provider)}>{operation === `discover:${provider.id}` ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}发现模型</button></div>
          {(discovered[provider.id]?.length ?? 0) > 0 && <div className="ai-discovered-models"><span>发现的模型</span><div>{discovered[provider.id].map((item) => <button key={item.apiModelId} onClick={() => selectDiscoveredModel(provider.id, item.apiModelId)}><Plus size={11} />{item.displayName}</button>)}</div></div>}
          {(modelsByProvider.get(provider.id)?.length ?? 0) > 0 && <div className="ai-model-list">{modelsByProvider.get(provider.id)!.map((model) => <div className="ai-model-row" key={model.id}>
            <div><strong>{model.displayName}</strong><small>{model.apiModelId}</small></div>
            <span>{model.modelKind === "embedding" ? "Embedding" : model.endpointKind === "responses" ? "Responses" : "Chat"}</span>
            <div className="ai-capability-tags">{model.capabilities.streaming && <i>流式</i>}{model.capabilities.functionCalling && <i>工具</i>}{model.capabilities.embeddings && <i>向量</i>}</div>
            <StatusBadge status={model.lastTestStatus} latency={model.lastTestLatencyMs} compact />
            <button title="重新测试" disabled={Boolean(operation)} onClick={() => void testModel(model)}>{operation === `test-model:${model.id}` ? <LoaderCircle className="spin" size={13} /> : <Zap size={13} />}</button>
            <button className="danger" title="删除" disabled={Boolean(operation)} onClick={() => void removeModel(model)}><Trash2 size={13} /></button>
          </div>)}</div>}
        </article>)}
      </div>}

      {providers.length > 0 && <div className="ai-model-form-wrap">
        <div className="ai-settings-section-title compact"><Plus size={14} /><div><h3>添加模型</h3><p>保存时会发送极短测试请求，验证基础调用、流式和工具能力。</p></div></div>
        <div className="ai-model-form">
          <label><span>所属 API</span><select value={modelForm.providerId} onChange={(event) => setModelForm({ ...modelForm, providerId: event.target.value })}><option value="">请选择</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}</select></label>
          <label><span>API model ID</span><input list="ai-discovered-model-options" value={modelForm.apiModelId} onChange={(event) => setModelForm({ ...modelForm, apiModelId: event.target.value, displayName: modelForm.displayName || event.target.value })} placeholder="例如 gpt-oss-120b" /><datalist id="ai-discovered-model-options">{Object.values(discovered).flat().map((item) => <option value={item.apiModelId} key={item.apiModelId} />)}</datalist></label>
          <label><span>显示名称</span><input value={modelForm.displayName} onChange={(event) => setModelForm({ ...modelForm, displayName: event.target.value })} placeholder="自定义名称" /></label>
          <label><span>模型类型</span><select value={modelForm.modelKind} onChange={(event) => { const kind = event.target.value as "chat" | "embedding"; setModelForm({ ...modelForm, modelKind: kind, endpointKind: kind === "embedding" ? "embeddings" : "chat-completions" }); }}><option value="chat">Chat / Reasoning</option><option value="embedding">Embedding</option></select></label>
          <label><span>接口</span><select value={modelForm.endpointKind} disabled={modelForm.modelKind === "embedding"} onChange={(event) => setModelForm({ ...modelForm, endpointKind: event.target.value as "chat-completions" | "responses" | "embeddings" })}><option value="chat-completions">/chat/completions</option><option value="responses">/responses</option><option value="embeddings">/embeddings</option></select></label>
          <label><span>数据区域（可选）</span><input value={modelForm.dataRegion} onChange={(event) => setModelForm({ ...modelForm, dataRegion: event.target.value })} placeholder="例如 Germany / EU" /></label>
          <label><span>上下文长度（可选）</span><input type="number" min="1" value={modelForm.contextWindow} onChange={(event) => setModelForm({ ...modelForm, contextWindow: event.target.value })} placeholder="例如 131072" /></label>
          <label><span>最大输出（可选）</span><input type="number" min="1" value={modelForm.maxOutputTokens} onChange={(event) => setModelForm({ ...modelForm, maxOutputTokens: event.target.value })} placeholder="例如 8192" /></label>
        </div>
        <button className="primary-button" disabled={Boolean(operation) || !modelForm.providerId || !modelForm.apiModelId} onClick={() => void saveModel()}>{operation === "model-save" && <LoaderCircle className="spin" size={14} />}测试并添加模型</button>
      </div>}

      {models.length > 0 && <><div className="ai-divider" /><div className="ai-settings-section-title"><ChevronDown size={15} /><div><h3>功能模型分配</h3><p>为每项能力指定主模型和备用模型；第一阶段仅保存路由配置。</p></div></div><div className="ai-binding-list">
        {bindings.map((binding) => {
          const eligible = models.filter((model) => binding.featureKey === "search.embedding" ? model.modelKind === "embedding" : model.modelKind === "chat");
          return <div className="ai-binding-row" key={binding.featureKey}><div><strong>{featureLabels[binding.featureKey].title}</strong><small>{featureLabels[binding.featureKey].detail}</small></div><label><span>主模型</span><select value={binding.primaryModelId ?? ""} onChange={(event) => updateBinding(binding.featureKey, "primaryModelId", event.target.value)}><option value="">未分配</option>{eligible.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label><label><span>备用模型</span><select value={binding.fallbackModelId ?? ""} onChange={(event) => updateBinding(binding.featureKey, "fallbackModelId", event.target.value)}><option value="">无</option>{eligible.filter((model) => model.id !== binding.primaryModelId).map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label></div>;
        })}
      </div><div className="ai-form-actions right"><button className="primary-button" disabled={Boolean(operation)} onClick={() => void saveBindings()}>{operation === "bindings-save" && <LoaderCircle className="spin" size={14} />}保存模型分配</button></div></>}

      <footer className="ai-security-note"><ShieldCheck size={15} /><p><strong>安全边界</strong>API Key 使用本机主密钥进行 AES-256-GCM 加密；前端只能看到“已保存”状态。私有网络默认禁止，所有外部请求均有超时和响应大小限制。</p></footer>
    </section>
  );
}

function StatusBadge({ status, latency, compact = false }: { readonly status: "untested" | "passed" | "failed"; readonly latency?: number; readonly compact?: boolean }) {
  return <span className={`ai-status-badge ${status} ${compact ? "compact" : ""}`}>{status === "passed" ? <CheckCircle2 size={11} /> : status === "failed" ? <CircleAlert size={11} /> : null}{status === "passed" ? `正常${latency !== undefined ? ` · ${latency} ms` : ""}` : status === "failed" ? "失败" : "未测试"}</span>;
}

async function requestJson<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers, ...init });
  const payload = await response.json().catch(() => null) as ({ readonly ok?: boolean; readonly message?: string } & T) | null;
  if (!response.ok || !payload?.ok) throw new Error(payload?.message || "操作失败，请稍后重试");
  return payload;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请稍后重试"; }
