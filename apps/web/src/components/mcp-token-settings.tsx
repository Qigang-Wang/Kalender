"use client";

import {
  CalendarClock,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { appConfirm } from "@/components/app-dialog-provider";

export type McpTokenUserRole = "admin" | "user" | "viewer";

type McpTokenScope = "dayline:read" | "dayline:write";

interface McpTokenMetadata {
  readonly id: string;
  readonly displayHint: string;
  readonly scopes: readonly McpTokenScope[];
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly lastUsedAt?: string;
  readonly createdAt: string;
  readonly name: string;
}

interface McpTokenListResponse {
  readonly ok: boolean;
  readonly tokens: readonly McpTokenMetadata[];
  readonly message?: string;
}

interface McpTokenCreateResponse {
  readonly ok: boolean;
  readonly token: McpTokenMetadata;
  readonly secret: string;
  readonly message?: string;
}

interface McpTokenRevokeResponse {
  readonly ok: boolean;
  readonly token: McpTokenMetadata;
  readonly message?: string;
}

interface SecretNotice {
  readonly tokenId: string;
  readonly tokenName: string;
  readonly displayHint: string;
  readonly secret: string;
}

interface Feedback {
  readonly kind: "success" | "error";
  readonly message: string;
}

const READ_SCOPE: McpTokenScope = "dayline:read";
const WRITE_SCOPE: McpTokenScope = "dayline:write";

function metadataFromToken(token: McpTokenMetadata): McpTokenMetadata {
  return {
    id: token.id,
    displayHint: token.displayHint,
    scopes: token.scopes.filter((scope): scope is McpTokenScope => scope === READ_SCOPE || scope === WRITE_SCOPE),
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    createdAt: token.createdAt,
    name: token.name,
  };
}

function errorMessage(payload: { readonly message?: string } | null, fallback: string): string {
  return payload?.message || fallback;
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "尚未使用";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function formatExpiry(value: string | undefined): string {
  return value ? formatDateTime(value) : "永不过期";
}

function tokenStatus(token: McpTokenMetadata, now: number): {
  readonly kind: "active" | "expired" | "revoked";
  readonly label: string;
  readonly detail: string;
} {
  if (token.revokedAt) return { kind: "revoked", label: "已撤销", detail: `撤销于 ${formatDateTime(token.revokedAt)}` };
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= now) {
    return { kind: "expired", label: "已过期", detail: `过期于 ${formatDateTime(token.expiresAt)}` };
  }
  return { kind: "active", label: "有效", detail: "可用于连接 Dayline MCP 服务" };
}

function localDateTimeMinimum(): string {
  const date = new Date(Date.now() + 60_000);
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function McpTokenSettings({ currentUserRole }: { readonly currentUserRole: McpTokenUserRole }) {
  const viewer = currentUserRole === "viewer";
  const [tokens, setTokens] = useState<readonly McpTokenMetadata[]>([]);
  const [name, setName] = useState("");
  const [allowWrite, setAllowWrite] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [secretNotice, setSecretNotice] = useState<SecretNotice>();
  const [now, setNow] = useState(() => Date.now());

  const expiryMinimum = useMemo(() => localDateTimeMinimum(), []);
  const selectedScopes = viewer || !allowWrite ? [READ_SCOPE] as const : [READ_SCOPE, WRITE_SCOPE] as const;

  const loadTokens = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/mcp-tokens", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as McpTokenListResponse | null;
      if (!response.ok || !payload?.ok || !Array.isArray(payload.tokens)) {
        throw new Error(errorMessage(payload, "无法读取 MCP API 令牌"));
      }
      // Keep the list metadata-only even if a proxy accidentally forwards an extra field.
      const metadata = payload.tokens.map(metadataFromToken);
      setTokens(metadata);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法读取 MCP API 令牌" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadTokens(); }, [loadTokens]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyAction) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFeedback({ kind: "error", message: "请输入令牌名称" });
      return;
    }

    let normalizedExpiry: string | undefined;
    if (expiresAt) {
      const expiry = new Date(expiresAt);
      if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
        setFeedback({ kind: "error", message: "过期时间必须晚于当前时间" });
        return;
      }
      normalizedExpiry = expiry.toISOString();
    }

    setBusyAction("create");
    setFeedback(undefined);
    try {
      const response = await fetch("/api/mcp-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          scopes: selectedScopes,
          ...(normalizedExpiry ? { expiresAt: normalizedExpiry } : {}),
        }),
      });
      const payload = await response.json().catch(() => null) as McpTokenCreateResponse | null;
      if (!response.ok || !payload?.ok || !payload.token) {
        throw new Error(errorMessage(payload, "无法创建 MCP API 令牌"));
      }

      const secret = payload.secret;
      if (!secret) throw new Error("服务未返回新令牌密钥，请重试");
      const metadata = metadataFromToken(payload.token);
      setSecretNotice({
        tokenId: metadata.id,
        tokenName: metadata.name,
        displayHint: metadata.displayHint,
        secret,
      });
      setName("");
      setAllowWrite(false);
      setExpiresAt("");
      await loadTokens();
      setFeedback({ kind: "success", message: "AI 客户端令牌已创建。密钥只显示一次，请立即复制。" });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法创建 MCP API 令牌" });
    } finally {
      setBusyAction(undefined);
    }
  };

  const copySecret = async () => {
    if (!secretNotice) return;
    try {
      if (!navigator.clipboard) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(secretNotice.secret);
      setFeedback({ kind: "success", message: "令牌密钥已复制到剪贴板" });
    } catch {
      setFeedback({ kind: "error", message: "无法自动复制，请手动复制密钥" });
    }
  };

  const revoke = async (token: McpTokenMetadata) => {
    if (busyAction) return;
    const label = token.name;
    if (!await appConfirm({
      title: `撤销 AI 客户端令牌“${label}”？`,
      description: "撤销后，使用此令牌的 MCP 客户端将无法继续访问 Dayline。此操作不可恢复。",
      confirmLabel: "撤销令牌",
      tone: "danger",
    })) return;

    setBusyAction(`revoke:${token.id}`);
    setFeedback(undefined);
    try {
      const response = await fetch(`/api/mcp-tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null) as McpTokenRevokeResponse | null;
      if (!response.ok || !payload?.ok || !payload.token) {
        throw new Error(errorMessage(payload, "无法撤销 MCP API 令牌"));
      }
      const revoked = metadataFromToken(payload.token);
      setTokens((current) => current.map((entry) => entry.id === revoked.id ? revoked : entry));
      if (secretNotice?.tokenId === revoked.id) setSecretNotice(undefined);
      setFeedback({ kind: "success", message: `“${label}”已撤销` });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "无法撤销 MCP API 令牌" });
    } finally {
      setBusyAction(undefined);
    }
  };

  return (
    <section className="mcp-token-settings panel" aria-labelledby="mcp-token-settings-title">
      <div className="settings-section-heading">
        <div>
          <h2 id="mcp-token-settings-title">AI 客户端</h2>
          <p>为外部 AI 客户端创建访问 Dayline MCP 服务的 API 令牌。</p>
        </div>
        <span className="step-badge"><KeyRound size={13} />MCP API</span>
      </div>

      <div className="mcp-token-security-note" role="note">
        <ShieldCheck size={18} />
        <div>
          <strong>令牌密钥只在创建时显示</strong>
          <span>Dayline 只保存不可逆哈希。请在创建后立即复制密钥，并将它安全地交给需要使用的 AI 客户端。</span>
        </div>
      </div>

      <form className="mcp-token-create-form" onSubmit={(event) => void submitCreate(event)}>
        <label>
          <span>令牌名称</span>
          <input
            required
            maxLength={80}
            value={name}
            placeholder="例如：Cursor 工作区"
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span>过期时间 <small>可选</small></span>
          <input type="datetime-local" min={expiryMinimum} step={60} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        </label>
        <fieldset className="mcp-token-scope-picker">
          <legend>访问权限</legend>
          <label className="mcp-token-scope-option required">
            <input type="checkbox" checked disabled />
            <span><strong>读取 Dayline</strong><small>访问 MCP 资源和工作区信息</small></span>
            <em>必选</em>
          </label>
          <label className={`mcp-token-scope-option ${viewer ? "disabled" : ""}`}>
            <input type="checkbox" checked={allowWrite} disabled={viewer || Boolean(busyAction)} onChange={(event) => setAllowWrite(event.target.checked)} />
            <span><strong>写入 Dayline</strong><small>{viewer ? "只读用户不能创建写入权限令牌" : "允许 AI 客户端创建或更新工作区内容"}</small></span>
            <em>{viewer ? "只读用户不可用" : "可选"}</em>
          </label>
        </fieldset>
        <footer className="mcp-token-create-actions">
          <span>每个令牌都绑定到当前账号。</span>
          <button className="primary-button" type="submit" disabled={Boolean(busyAction) || !name.trim()}>
            {busyAction === "create" ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
            {busyAction === "create" ? "正在创建…" : "创建令牌"}
          </button>
        </footer>
      </form>

      {secretNotice && (
        <section className="mcp-token-secret-notice" aria-labelledby="mcp-token-secret-title" role="alert">
          <header>
            <div>
              <strong id="mcp-token-secret-title">新令牌密钥只显示一次</strong>
              <span>“{secretNotice.tokenName}” · {secretNotice.displayHint}。复制后请关闭此提示。</span>
            </div>
            <button type="button" aria-label="关闭令牌密钥提示" title="关闭提示" onClick={() => setSecretNotice(undefined)}><X size={15} /></button>
          </header>
          <div className="mcp-token-secret-copy">
            <input readOnly autoComplete="off" value={secretNotice.secret} aria-label="新令牌密钥" onFocus={(event) => event.currentTarget.select()} />
            <button className="secondary-button" type="button" onClick={() => void copySecret()}><Copy size={14} />复制密钥</button>
          </div>
        </section>
      )}

      {feedback && (
        <div className={`mcp-token-feedback ${feedback.kind}`} role="status" aria-live="polite">
          {feedback.kind === "success" ? <Check size={15} /> : <CircleAlert size={15} />}
          <span>{feedback.message}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setFeedback(undefined)}><X size={13} /></button>
        </div>
      )}

      <section className="mcp-token-list" aria-labelledby="mcp-token-list-title">
        <header className="mcp-token-list-heading">
          <div>
            <h3 id="mcp-token-list-title">已创建的令牌</h3>
            <p>列表只显示元数据，不会再次显示完整密钥。</p>
          </div>
          <span>{tokens.length} 个</span>
        </header>
        {loading ? (
          <div className="mcp-token-empty"><LoaderCircle className="spin" size={17} />正在读取令牌…</div>
        ) : tokens.length === 0 ? (
          <div className="mcp-token-empty"><KeyRound size={20} /><strong>尚未创建 AI 客户端令牌</strong><span>创建一个令牌后，连接信息会显示在这里。</span></div>
        ) : (
          <div className="mcp-token-cards">
            {tokens.map((token) => {
              const status = tokenStatus(token, now);
              const label = token.name;
              const revoking = busyAction === `revoke:${token.id}`;
              return (
                <article className={`mcp-token-card ${status.kind}`} key={token.id}>
                  <header>
                    <div className="mcp-token-card-title">
                      <strong>{label}</strong>
                      <code>{token.displayHint}</code>
                    </div>
                    <span className={`mcp-token-status ${status.kind}`}>{status.label}</span>
                  </header>
                  <div className="mcp-token-metadata">
                    <span><KeyRound size={13} /><b>权限</b>{token.scopes.includes(WRITE_SCOPE) ? "读取、写入" : "读取"}</span>
                    <span><CalendarClock size={13} /><b>创建</b>{formatDateTime(token.createdAt)}</span>
                    <span><Clock3 size={13} /><b>到期</b>{formatExpiry(token.expiresAt)}</span>
                    <span><Clock3 size={13} /><b>最近使用</b>{formatDateTime(token.lastUsedAt)}</span>
                  </div>
                  <footer>
                    <small>{status.detail}</small>
                    {status.kind === "active" && (
                      <button className="danger-button" type="button" disabled={Boolean(busyAction)} onClick={() => void revoke(token)}>
                        {revoking ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}撤销
                      </button>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}
