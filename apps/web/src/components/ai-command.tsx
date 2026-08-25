"use client";

import { useChat } from "@ai-sdk/react";
import { Bot, CircleAlert, Clock3, LoaderCircle, MessageSquarePlus, RotateCcw, Send, Settings, ShieldCheck, Square, Trash2, User, WandSparkles } from "lucide-react";
import Link from "next/link";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { appConfirm } from "@/components/app-dialog-provider";
import { AppSelect } from "@/components/app-select";

interface CommandDataParts {
  [key: string]: unknown;
  conversation: { readonly id: string; readonly title: string };
  model: { readonly runId: string; readonly providerName: string; readonly modelId: string; readonly modelName: string; readonly usedFallback: boolean };
  fallback: { readonly fromModelName: string; readonly toModelName: string };
  run: { readonly runId: string; readonly status: "succeeded" | "failed" | "cancelled"; readonly latencyMs: number };
}

type CommandMessage = UIMessage<unknown, CommandDataParts>;

interface ConversationView {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly preview?: string;
}

interface StoredMessageView {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly status: "complete" | "partial";
}

interface AvailableModel {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly apiModelId: string;
  readonly modelKind: "chat" | "embedding";
  readonly enabled: boolean;
  readonly lastTestStatus: "untested" | "passed" | "failed";
}

interface ProviderView { readonly id: string; readonly displayName: string; readonly enabled: boolean }

export function AiCommand() {
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string>();
  const [conversations, setConversations] = useState<readonly ConversationView[]>([]);
  const [availableModels, setAvailableModels] = useState<readonly (AvailableModel & { readonly providerName: string })[]>([]);
  const [requestedModelId, setRequestedModelId] = useState("");
  const [activeModel, setActiveModel] = useState<CommandDataParts["model"]>();
  const [fallbackNotice, setFallbackNotice] = useState<CommandDataParts["fallback"]>();
  const [runSummary, setRunSummary] = useState<CommandDataParts["run"]>();
  const [feedback, setFeedback] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const conversationIdRef = useRef<string | undefined>(undefined);
  const requestedModelIdRef = useRef("");
  const messageEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  useEffect(() => { requestedModelIdRef.current = requestedModelId; }, [requestedModelId]);

  const loadConversations = useCallback(async () => {
    try {
      const payload = await requestJson<{ conversations: readonly ConversationView[] }>("/api/ai/conversations");
      setConversations(payload.conversations);
    } catch (error) { setFeedback(errorMessage(error)); }
  }, []);

  useEffect(() => {
    void loadConversations();
    void requestJson<{ providers: readonly ProviderView[]; models: readonly AvailableModel[] }>("/api/ai/providers")
      .then((payload) => {
        const providerMap = new Map(payload.providers.filter((provider) => provider.enabled).map((provider) => [provider.id, provider.displayName]));
        setAvailableModels(payload.models
          .filter((model) => model.enabled && model.modelKind === "chat" && providerMap.has(model.providerId))
          .map((model) => ({ ...model, providerName: providerMap.get(model.providerId)! })));
      })
      .catch((error) => setFeedback(errorMessage(error)));
  }, [loadConversations]);

  const transport = useMemo(() => new DefaultChatTransport<CommandMessage>({
    api: "/api/ai/chat",
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        messages,
        conversationId: conversationIdRef.current,
        requestedModelId: requestedModelIdRef.current || undefined,
      },
    }),
  }), []);

  const {
    messages,
    sendMessage,
    regenerate,
    stop,
    status,
    error,
    setMessages,
    clearError,
  } = useChat<CommandMessage>({
    id: "kalender-ai-command",
    transport,
    throttle: 30,
    onData: (part) => {
      if (part.type === "data-conversation") {
        const data = part.data as CommandDataParts["conversation"];
        conversationIdRef.current = data.id;
        setConversationId(data.id);
      } else if (part.type === "data-model") {
        setActiveModel(part.data as CommandDataParts["model"]);
      } else if (part.type === "data-fallback") {
        setFallbackNotice(part.data as CommandDataParts["fallback"]);
      } else if (part.type === "data-run") {
        setRunSummary(part.data as CommandDataParts["run"]);
      }
    },
    onError: (nextError) => setFeedback(nextError.message),
    onFinish: () => { void loadConversations(); },
  });

  const busy = status === "submitted" || status === "streaming";
  useEffect(() => { messageEndRef.current?.scrollIntoView({ block: "end", behavior: busy ? "auto" : "smooth" }); }, [busy, messages]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = input.trim();
    if (!prompt || busy) return;
    setInput("");
    setFeedback(undefined);
    setFallbackNotice(undefined);
    setRunSummary(undefined);
    clearError();
    await sendMessage({ text: prompt });
  };

  const newConversation = async () => {
    if (busy) await stop();
    conversationIdRef.current = undefined;
    setConversationId(undefined);
    setMessages([]);
    setInput("");
    setActiveModel(undefined);
    setFallbackNotice(undefined);
    setRunSummary(undefined);
    setFeedback(undefined);
    setSidebarOpen(false);
  };

  const openConversation = async (id: string) => {
    if (busy) await stop();
    try {
      const payload = await requestJson<{ conversation: ConversationView; messages: readonly StoredMessageView[] }>(`/api/ai/conversations/${id}`);
      conversationIdRef.current = id;
      setConversationId(id);
      setMessages(payload.messages.map((message) => ({
        id: message.id,
        role: message.role,
        parts: [{ type: "text", text: message.text }],
        metadata: message.status === "partial" ? { partial: true } : undefined,
      })) as CommandMessage[]);
      setActiveModel(undefined);
      setFallbackNotice(undefined);
      setRunSummary(undefined);
      setFeedback(undefined);
      setSidebarOpen(false);
    } catch (nextError) { setFeedback(errorMessage(nextError)); }
  };

  const deleteConversation = async (conversation: ConversationView) => {
    if (!await appConfirm({
      title: `Unterhaltung „${conversation.title}“ löschen?`,
      description: "Dialogaufzeichnungen werden dauerhaft gelöscht.",
      confirmLabel: "Dialog löschen",
      tone: "danger",
    })) return;
    try {
      await requestJson(`/api/ai/conversations/${conversation.id}`, { method: "DELETE" });
      if (conversationId === conversation.id) await newConversation();
      await loadConversations();
    } catch (nextError) { setFeedback(errorMessage(nextError)); }
  };

  const retry = async () => {
    setFeedback(undefined);
    setFallbackNotice(undefined);
    setRunSummary(undefined);
    clearError();
    await regenerate();
  };

  return (
    <section className="ai-command-shell panel">
      <aside className={`ai-command-history ${sidebarOpen ? "open" : ""}`}>
        <header><strong>Dialog</strong><button title="Neuer Dialog" onClick={() => void newConversation()}><MessageSquarePlus size={15} /></button></header>
        <div className="ai-conversation-list">
          {conversations.length === 0 ? <p>UI-Text: Nach dem Senden der ersten Nachricht wird der Dialog lokal gespeichert.</p> : conversations.map((conversation) => <div className={`ai-conversation-item ${conversation.id === conversationId ? "active" : ""}`} key={conversation.id}>
            <button onClick={() => void openConversation(conversation.id)}><strong>{conversation.title}</strong><small>{formatConversationTime(conversation.updatedAt)} · {conversation.messageCount} bar</small></button>
            <button className="danger" title="Dialog löschen" onClick={() => void deleteConversation(conversation)}><Trash2 size={12} /></button>
          </div>)}
        </div>
      </aside>

      <div className="ai-command-main">
        <header className="ai-command-toolbar">
          <button className="ai-history-toggle" onClick={() => setSidebarOpen((value) => !value)}>Dialog</button>
          <div><span><WandSparkles size={14} />AI Command</span><small>Derzeit wird nur Dialog geführt und keine Workspace-Daten werden gelesen oder geändert</small></div>
          <label><span className="sr-only">Modell</span><AppSelect ariaLabel="Modell" size="compact" value={requestedModelId} onValueChange={setRequestedModelId} disabled={busy} options={[{ value: "", label: "Autoselect-Modell" }, ...availableModels.map((model) => ({ value: model.id, label: `${model.displayName} · ${model.providerName}` }))]} /></label>
        </header>

        <div className="ai-command-messages" aria-live="polite">
          {messages.length === 0 ? <div className="ai-command-empty"><div><Bot size={25} /></div><h2>Was willst du zusammen denken?</h2><p>Ein echter Flow Dialog ist nun möglich. E-Mail, Kalender, Aufgaben und Notizen wurden noch nicht an das Modell gesendet.</p><div><button onClick={() => setInput("Helfen Sie mir, die drei wichtigsten Dinge des Tages zu planen und erklären Sie die Gründe für ihre Sequenzierung.")}>Planungsprioritäten</button><button onClick={() => setInput("Setzen Sie die folgenden Ideen in einen klaren Umsetzungsplan:")}>Zusammenstellung der Durchführungspläne</button></div>{availableModels.length === 0 && <Link href="/settings"><Settings size={14} />AI-Modelle zuerst konfigurieren</Link>}</div> : messages.map((message) => {
            const text = message.parts.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("");
            return <article className={`ai-chat-message ${message.role}`} key={message.id}>
              <div className="ai-chat-avatar">{message.role === "user" ? <User size={15} /> : <Bot size={15} />}</div>
              <div><header><strong>{message.role === "user" ? "Sie" : "Dayline AI"}</strong>{message.role === "assistant" && activeModel && message === messages[messages.length - 1] && <span>{activeModel.modelName}{activeModel.usedFallback ? " . . . . . . . . . . ." : ""}</span>}</header><p>{text}{message.role === "assistant" && busy && message === messages[messages.length - 1] && <i className="ai-stream-caret" />}</p></div>
            </article>;
          })}
          {status === "submitted" && <div className="ai-command-thinking"><LoaderCircle className="spin" size={15} />Verbindendes Modell...</div>}
          <div ref={messageEndRef} />
        </div>

        {(fallbackNotice || feedback || error) && <div className={`ai-command-notice ${feedback || error ? "error" : ""}`}>
          {feedback || error ? <CircleAlert size={14} /> : <RotateCcw size={14} />}
          <span>{feedback || error?.message || `Hauptmodell ${fallbackNotice?.fromModelName} nicht verfügbar, umgeschaltet auf ${fallbackNotice?.toModelName}`}</span>
          {(feedback || error) && messages.some((message) => message.role === "user") && !busy && <button onClick={() => void retry()}><RotateCcw size={12} />Erneut versuchen</button>}
        </div>}

        <form className="ai-command-composer" onSubmit={(event) => void submit(event)}>
          <textarea value={input} maxLength={20_000} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} placeholder="Eingabemeldungen; Senden, Umschalten + Eingeben" disabled={busy} />
          <footer><div>{activeModel ? <span><Bot size={12} />{activeModel.providerName} / {activeModel.modelName}</span> : <span><ShieldCheck size={12} />keine Workspace-Daten gesendet</span>}{runSummary?.status === "succeeded" && <span><Clock3 size={12} />{runSummary.latencyMs} ms</span>}</div>{busy ? <button type="button" className="ai-stop-button" onClick={() => void stop()}><Square size={12} />Anhalten</button> : <button className="primary-button" disabled={!input.trim() || availableModels.length === 0}><Send size={14} />Senden</button>}</footer>
        </form>
      </div>
    </section>
  );
}

async function requestJson<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null) as ({ readonly ok?: boolean; readonly message?: string } & T) | null;
  if (!response.ok || !payload?.ok) throw new Error(payload?.message || "Operation fehlgeschlagen, bitte versuchen Sie es später noch einmal");
  return payload;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Operation fehlgeschlagen, bitte versuchen Sie es später noch einmal"; }

function formatConversationTime(value: string): string {
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat("de-DE", sameDay ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric" }).format(date);
}
