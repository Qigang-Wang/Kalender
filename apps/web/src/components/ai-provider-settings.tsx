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

import { appConfirm } from "@/components/app-dialog-provider";
import { AppSelect } from "@/components/app-select";

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
  "assistant.default": { title: "KI-Befehls-Standard", detail: "Allgemeine Fragen & Antworten & Workspace Assistant" },
  "assistant.planning": { title: "komplexe Planung", detail: "Pläne für Cross-Mail, Kalender und Aufgaben" },
  "mail.summarize": { title: "Zusammenfassung der Mails", detail: "Lange-Mail-Sitzung komprimiert" },
  "mail.extract_actions": { title: "Mail-Aktionsposten", detail: "Anerkennungsfristen und Aufgaben" },
  "mail.draft_reply": { title: "Entwurf einer E-Mail-Antwort", detail: "nur Entwürfe werden generiert und nicht automatisch gesendet" },
  "notes.editor": { title: "Notizbearbeitung", detail: "Umschreiben, organisieren und komplettieren" },
  "today.briefing": { title: "Tagesübersicht", detail: "synthetisiert Informationen, die für den Tag wichtig sind" },
  "search.embedding": { title: "semantische Suche", detail: "Nur Modelle einbetten werden ausgewählt" },
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
  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [discovered, setDiscovered] = useState<Record<string, readonly DiscoveredModel[]>>({});
  const [modelForm, setModelForm] = useState(emptyModelForm);
  const [modelFormOpen, setModelFormOpen] = useState(false);

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
    setFeedback({ kind: "info", message: "Modellliste validieren und lesen..." });
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
    setFeedback({ kind: "info", message: "Wiedertesten der Verbindung vor dem Speichern..." });
    try {
      const path = editingProviderId ? `/api/ai/providers/${editingProviderId}` : "/api/ai/providers";
      const payload = await requestJson<{ provider: AiProviderView; discoveredModels: readonly DiscoveredModel[] }>(path, {
        method: editingProviderId ? "PATCH" : "POST",
        body: JSON.stringify(providerPayload()),
      });
      setDiscovered((current) => ({ ...current, [payload.provider.id]: payload.discoveredModels }));
      setFeedback({ kind: "success", message: `“${payload.provider.displayName}"Sicher gespeichert, API Key wird nicht den Browser zurückgeben` });
      resetProviderForm();
      await load();
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally { setOperation(undefined); }
  };

  const editProvider = (provider: AiProviderView) => {
    setProviderFormOpen(true);
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
    setProviderFormOpen(false);
    setShowApiKey(false);
  };

  const removeProvider = async (provider: AiProviderView) => {
    if (!await appConfirm({
      title: `AI-Dienst löschen "${provider.displayName}“?`,
      description: "Alle Modellkonfigurationen unter diesem Dienst werden ebenfalls gelöscht.",
      confirmLabel: "Service löschen",
      tone: "danger",
    })) return;
    setOperation(`delete-provider:${provider.id}`);
    try {
      await requestJson(`/api/ai/providers/${provider.id}`, { method: "DELETE" });
      if (editingProviderId === provider.id) resetProviderForm();
      setFeedback({ kind: "success", message: `“${provider.displayName}"Gelöscht` });
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
      setModelFormOpen(true);
      setFeedback({ kind: "success", message: `gefunden ${payload.models.length} ein Modell, wählen Sie das zu verwendende Modell` });
    } catch (error) { setFeedback({ kind: "error", message: errorMessage(error) }); }
    finally { setOperation(undefined); }
  };

  const selectDiscoveredModel = (providerId: string, apiModelId: string) => {
    setModelFormOpen(true);
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
    setFeedback({ kind: "info", message: "Aufrufen von Modellen und Erkennung von Flow-Output- und Tool-Call-Funktionen..." });
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
      setFeedback({ kind: "success", message: `Modell${payload.model.displayName}"Hinzugefügt und getestet mit Grundruf` });
      setModelForm({ ...emptyModelForm, providerId: modelForm.providerId });
      setModelFormOpen(false);
      await load();
    } catch (error) { setFeedback({ kind: "error", message: errorMessage(error) }); }
    finally { setOperation(undefined); }
  };

  const testModel = async (model: AiModelView) => {
    setOperation(`test-model:${model.id}`);
    try {
      const payload = await requestJson<{ model: AiModelView }>(`/api/ai/models/${model.id}/test`, { method: "POST" });
      setFeedback({ kind: "success", message: `“${payload.model.displayName}"getestet durch .. ${payload.model.lastTestLatencyMs ?? 0} ms` });
      await load();
    } catch (error) { setFeedback({ kind: "error", message: errorMessage(error) }); }
    finally { setOperation(undefined); }
  };

  const removeModel = async (model: AiModelView) => {
    if (!await appConfirm({
      title: `Modell löschen "${model.displayName}“?`,
      description: "Die Verwendung der Funktionsbindung des Modells wird automatisch entleert.",
      confirmLabel: "Modell löschen",
      tone: "danger",
    })) return;
    setOperation(`delete-model:${model.id}`);
    try {
      await requestJson(`/api/ai/models/${model.id}`, { method: "DELETE" });
      setFeedback({ kind: "success", message: `Modell${model.displayName}"Gelöscht` });
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
      setFeedback({ kind: "success", message: "Eingesparte funktionale Modellzuordnung" });
      await load();
    } catch (error) { setFeedback({ kind: "error", message: errorMessage(error) }); }
    finally { setOperation(undefined); }
  };

  const modelsByProvider = useMemo(() => new Map(providers.map((provider) => [
    provider.id, models.filter((model) => model.providerId === provider.id),
  ])), [models, providers]);

  return (
    <section className="panel ai-provider-settings">
      <header className="settings-section-heading"><h2>KI API und Modell</h2></header>

      {feedback && <div className={`ai-settings-feedback ${feedback.kind}`} role="status">
        {feedback.kind === "success" ? <CheckCircle2 size={15} /> : feedback.kind === "error" ? <CircleAlert size={15} /> : <LoaderCircle className={operation ? "spin" : ""} size={15} />}
        <span>{feedback.message}</span><button aria-label="Schalten Sie den Hinweis aus" onClick={() => setFeedback(undefined)}><X size={13} /></button>
      </div>}

      {(!loading && (providers.length === 0 || providerFormOpen || editingProviderId)) ? <>
        <div className="ai-settings-section-title"><Server size={15} /><div><h3>{editingProviderId ? "API bearbeiten" : "API verbinden"}</h3><p>Verbindungen werden vor dem Speichern getestet und Schlüssel werden nicht an den Browser zurückgegeben.</p></div></div>
        <div className="ai-provider-form">
          <label><span>API-Name</span><input value={providerForm.displayName} onChange={(event) => setProviderForm({ ...providerForm, displayName: event.target.value })} placeholder="z.B. KI Connect" /></label>
          <label className="wide"><span>API Base URL</span><input value={providerForm.baseUrl} onChange={(event) => setProviderForm({ ...providerForm, baseUrl: event.target.value })} placeholder="https://…/v1" inputMode="url" /></label>
          <label className="wide"><span>API Key {editingProviderId && <small>leer lassen ohne Änderungen</small>}</span><div className="ai-secret-input"><KeyRound size={14} /><input type={showApiKey ? "text" : "password"} autoComplete="new-password" value={providerForm.apiKey} onChange={(event) => setProviderForm({ ...providerForm, apiKey: event.target.value })} placeholder={editingProviderId ? "sicher gespeichert" : "API-Schlüssel eingeben"} /><button aria-label={showApiKey ? "API-Schlüssel ausblenden" : "API-Schlüssel anzeigen"} onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
          <label><span>Authentifizierungsmethode</span><AppSelect ariaLabel="Authentifizierungsmethode" value={providerForm.authScheme} onValueChange={(authScheme) => setProviderForm({ ...providerForm, authScheme: authScheme as "bearer" | "custom-header" })} options={[{ value: "bearer", label: "Bearer Token" }, { value: "custom-header", label: "Benutzerdefinierte Kopfzeile" }]} /></label>
          {providerForm.authScheme === "custom-header" && <label><span>Kopfname</span><input value={providerForm.authHeaderName} onChange={(event) => setProviderForm({ ...providerForm, authHeaderName: event.target.value })} placeholder="api-key" /></label>}
          <label><span>Timeout (Sekunden)</span><input type="number" min="1" max="120" value={providerForm.requestTimeoutMs / 1000} onChange={(event) => setProviderForm({ ...providerForm, requestTimeoutMs: Number(event.target.value) * 1000 })} /></label>
          <label className="ai-checkbox-label"><input type="checkbox" checked={providerForm.allowPrivateNetwork} onChange={(event) => setProviderForm({ ...providerForm, allowPrivateNetwork: event.target.checked })} /><span>Zugang zu Wohn-/privaten Netzwerkmodellen ermöglichen</span></label>
        </div>
        <div className="ai-form-actions">
          <button className="secondary-button" disabled={Boolean(operation) || !providerForm.baseUrl} onClick={() => void testProvider()}>{operation === "provider-test" ? <LoaderCircle className="spin" size={14} /> : <Zap size={14} />}Prüfanschluss</button>
          <button className="primary-button" disabled={Boolean(operation) || !providerForm.baseUrl || (!editingProviderId && !providerForm.apiKey)} onClick={() => void saveProvider()}>{operation === "provider-save" && <LoaderCircle className="spin" size={14} />}{editingProviderId ? "Änderungen speichern" : "testen und speichern"}</button>
          {providers.length > 0 && <button className="quiet-button" onClick={resetProviderForm}>Abbrechen</button>}
        </div>
        <div className="ai-divider" />
      </> : null}
      <div className="ai-settings-section-title"><Bot size={15} /><div><h3>API und Modell</h3></div><span>{providers.length} eine API: {models.length} ein Modell</span>{providers.length > 0 && !providerFormOpen && <button className="secondary-button" onClick={() => setProviderFormOpen(true)}><Plus size={14} />API verbinden</button>}</div>
      {loading ? <div className="ai-settings-empty"><LoaderCircle className="spin" size={18} />Konfiguration lesen...</div> : providers.length === 0 ? <div className="ai-settings-empty"><Server size={20} /><strong>nicht mit AI API verbunden</strong><span>Sie können es nach dem Ausfüllen der oben genannten Informationen und dem Testen speichern.</span></div> : <div className="ai-provider-list">
        {providers.map((provider) => <article className="ai-provider-card" key={provider.id}>
          <header><div className="ai-provider-symbol"><Server size={16} /></div><div><h4>{provider.displayName}</h4><p>{provider.baseUrl}</p></div><StatusBadge status={provider.lastTestStatus} latency={provider.lastTestLatencyMs} /><button title="Bearbeiten" onClick={() => editProvider(provider)}><Pencil size={14} /></button><button className="danger" title="Löschen" disabled={Boolean(operation)} onClick={() => void removeProvider(provider)}><Trash2 size={14} /></button></header>
          <div className="ai-provider-meta"><span><ShieldCheck size={12} />Schlüssel verschlüsselt</span><span>{provider.authScheme === "bearer" ? "Bearer" : provider.authHeaderName}</span><span>{provider.modelCount} ein Modell</span><button disabled={Boolean(operation)} onClick={() => void discoverModels(provider)}>{operation === `discover:${provider.id}` ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}Modell entdecken</button></div>
          {(discovered[provider.id]?.length ?? 0) > 0 && <div className="ai-discovered-models"><span>Modelle gefunden</span><div>{discovered[provider.id].map((item) => <button key={item.apiModelId} onClick={() => selectDiscoveredModel(provider.id, item.apiModelId)}><Plus size={11} />{item.displayName}</button>)}</div></div>}
          {(modelsByProvider.get(provider.id)?.length ?? 0) > 0 && <div className="ai-model-list">{modelsByProvider.get(provider.id)!.map((model) => <div className="ai-model-row" key={model.id}>
            <div><strong>{model.displayName}</strong><small>{model.apiModelId}</small></div>
            <span>{model.modelKind === "embedding" ? "Embedding" : model.endpointKind === "responses" ? "Responses" : "Chat"}</span>
            <div className="ai-capability-tags">{model.capabilities.streaming && <i>Durchsatz</i>}{model.capabilities.functionCalling && <i>Werkzeuge</i>}{model.capabilities.embeddings && <i>Vektor</i>}</div>
            <StatusBadge status={model.lastTestStatus} latency={model.lastTestLatencyMs} compact />
            <button title="Wiederholungstest" disabled={Boolean(operation)} onClick={() => void testModel(model)}>{operation === `test-model:${model.id}` ? <LoaderCircle className="spin" size={13} /> : <Zap size={13} />}</button>
            <button className="danger" title="Löschen" disabled={Boolean(operation)} onClick={() => void removeModel(model)}><Trash2 size={13} /></button>
          </div>)}</div>}
        </article>)}
      </div>}

      {providers.length > 0 && !modelFormOpen && <div className="ai-collapsed-form-action">
        <button className="secondary-button" onClick={() => setModelFormOpen(true)}><Plus size={14} />Modell hinzufügen</button>
      </div>}
      {providers.length > 0 && modelFormOpen && <div className="ai-model-form-wrap">
        <div className="ai-settings-section-title compact"><Plus size={14} /><div><h3>Modell hinzufügen</h3><p>Anfragen für sehr kurze Tests werden gesendet, wenn gespeichert, um grundlegende Call-, Flow- und Werkzeugfunktionen zu validieren.</p></div></div>
        <div className="ai-model-form">
          <label><span>zur API gehörend</span><AppSelect ariaLabel="zur API gehörend" value={modelForm.providerId} onValueChange={(providerId) => setModelForm({ ...modelForm, providerId })} options={[{ value: "", label: "auswählen" }, ...providers.map((provider) => ({ value: provider.id, label: provider.displayName }))]} /></label>
          <label><span>API model ID</span><input list="ai-discovered-model-options" value={modelForm.apiModelId} onChange={(event) => setModelForm({ ...modelForm, apiModelId: event.target.value, displayName: modelForm.displayName || event.target.value })} placeholder="z.B. gpt-oss-120b" /><datalist id="ai-discovered-model-options">{Object.values(discovered).flat().map((item) => <option value={item.apiModelId} key={item.apiModelId} />)}</datalist></label>
          <label><span>Anzeigename</span><input value={modelForm.displayName} onChange={(event) => setModelForm({ ...modelForm, displayName: event.target.value })} placeholder="Benutzerdefinierter Name" /></label>
          <label><span>Typ des Modells</span><AppSelect ariaLabel="Typ des Modells" value={modelForm.modelKind} onValueChange={(value) => { const kind = value as "chat" | "embedding"; setModelForm({ ...modelForm, modelKind: kind, endpointKind: kind === "embedding" ? "embeddings" : "chat-completions" }); }} options={[{ value: "chat", label: "Chat / Reasoning" }, { value: "embedding", label: "Embedding" }]} /></label>
          <label><span>Schnittstelle</span><AppSelect ariaLabel="Schnittstelle" value={modelForm.endpointKind} disabled={modelForm.modelKind === "embedding"} onValueChange={(endpointKind) => setModelForm({ ...modelForm, endpointKind: endpointKind as "chat-completions" | "responses" | "embeddings" })} options={[{ value: "chat-completions", label: "/chat/completions" }, { value: "responses", label: "/responses" }, { value: "embeddings", label: "/embeddings" }]} /></label>
          <label><span>Datenbereich (fakultativ)</span><input value={modelForm.dataRegion} onChange={(event) => setModelForm({ ...modelForm, dataRegion: event.target.value })} placeholder="z. B. Deutschland/EU" /></label>
          <label><span>Kontextlänge (optional)</span><input type="number" min="1" value={modelForm.contextWindow} onChange={(event) => setModelForm({ ...modelForm, contextWindow: event.target.value })} placeholder="z.B. 131072" /></label>
          <label><span>Maximale Ausgabe (optional)</span><input type="number" min="1" value={modelForm.maxOutputTokens} onChange={(event) => setModelForm({ ...modelForm, maxOutputTokens: event.target.value })} placeholder="== Einzelnachweise ==" /></label>
        </div>
        <div className="ai-form-actions">
          <button className="primary-button" disabled={Boolean(operation) || !modelForm.providerId || !modelForm.apiModelId} onClick={() => void saveModel()}>{operation === "model-save" && <LoaderCircle className="spin" size={14} />}Testen und Hinzufügen von Modellen</button>
          <button className="quiet-button" onClick={() => setModelFormOpen(false)}>Abbrechen</button>
        </div>
      </div>}

      {models.length > 0 && <><div className="ai-divider" /><div className="ai-settings-section-title"><ChevronDown size={15} /><div><h3>funktionale Modellzuweisung</h3><p>Gibt das Hauptmodell und das Backup-Modell für jede Funktion an.</p></div></div><div className="ai-binding-list">
        {bindings.map((binding) => {
          const eligible = models.filter((model) => binding.featureKey === "search.embedding" ? model.modelKind === "embedding" : model.modelKind === "chat");
          return <div className="ai-binding-row" key={binding.featureKey}><div><strong>{featureLabels[binding.featureKey].title}</strong><small>{featureLabels[binding.featureKey].detail}</small></div><label><span>Hauptmodell</span><AppSelect ariaLabel={`${featureLabels[binding.featureKey].title}Hauptmodell`} size="compact" value={binding.primaryModelId ?? ""} onValueChange={(modelId) => updateBinding(binding.featureKey, "primaryModelId", modelId)} options={[{ value: "", label: "nicht verteilt" }, ...eligible.map((model) => ({ value: model.id, label: model.displayName }))]} /></label><label><span>Rückwärts-Modell</span><AppSelect ariaLabel={`${featureLabels[binding.featureKey].title}Rückwärts-Modell`} size="compact" value={binding.fallbackModelId ?? ""} onValueChange={(modelId) => updateBinding(binding.featureKey, "fallbackModelId", modelId)} options={[{ value: "", label: "keine" }, ...eligible.filter((model) => model.id !== binding.primaryModelId).map((model) => ({ value: model.id, label: model.displayName }))]} /></label></div>;
        })}
      </div><div className="ai-form-actions right"><button className="primary-button" disabled={Boolean(operation)} onClick={() => void saveBindings()}>{operation === "bindings-save" && <LoaderCircle className="spin" size={14} />}Modellzuweisungen speichern</button></div></>}

      <footer className="ai-security-note"><ShieldCheck size={15} /><p><strong>Sicherheitsgrenzen</strong>API-Schlüssel verschlüsselt AES-256-GCM mit seinem Host-Schlüssel; nur " gespeichert " Status kann am vorderen Ende gesehen werden. Das private Netzwerk ist standardmäßig verboten, und alle externen Anfragen sind zeitaufwändig und reagieren.</p></footer>
    </section>
  );
}

function StatusBadge({ status, latency, compact = false }: { readonly status: "untested" | "passed" | "failed"; readonly latency?: number; readonly compact?: boolean }) {
  return <span className={`ai-status-badge ${status} ${compact ? "compact" : ""}`}>{status === "passed" ? <CheckCircle2 size={11} /> : status === "failed" ? <CircleAlert size={11} /> : null}{status === "passed" ? `Normal${latency !== undefined ? ` · ${latency} ms` : ""}` : status === "failed" ? "fehlgeschlagen" : "nicht getestet"}</span>;
}

async function requestJson<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers, ...init });
  const payload = await response.json().catch(() => null) as ({ readonly ok?: boolean; readonly message?: string } & T) | null;
  if (!response.ok || !payload?.ok) throw new Error(payload?.message || "Operation fehlgeschlagen, bitte versuchen Sie es später noch einmal");
  return payload;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Operation fehlgeschlagen, bitte versuchen Sie es später noch einmal"; }
