"use client";

import { Check, LoaderCircle, Mail, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { appConfirm } from "./app-dialog-provider";
import { AppSelect } from "./app-select";

export interface MailSignatureAccount {
  readonly id: string;
  readonly displayName: string;
  readonly emailAddress: string;
}

export interface ClientMailSignature {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly fullText: string;
  readonly shortText: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SignatureDraft {
  readonly name: string;
  readonly fullText: string;
  readonly shortText: string;
  readonly makeDefault: boolean;
}

const emptyDraft = (): SignatureDraft => ({
  name: "",
  fullText: "",
  shortText: "",
  makeDefault: false,
});

export function MailSignatureSettings({ accounts }: { readonly accounts: readonly MailSignatureAccount[] }) {
  const [signatures, setSignatures] = useState<readonly ClientMailSignature[]>([]);
  const [accountId, setAccountId] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<SignatureDraft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    if (accounts.length === 0) {
      setAccountId("");
      return;
    }
    setAccountId((current) => accounts.some((account) => account.id === current) ? current : accounts[0]!.id);
  }, [accounts]);

  const loadSignatures = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/mail-signatures", { cache: "no-store" });
      const payload = await response.json() as {
        readonly signatures?: readonly ClientMailSignature[];
        readonly message?: string;
      };
      if (!response.ok) throw new Error(payload.message || "无法读取邮件签名");
      setSignatures(payload.signatures ?? []);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法读取邮件签名");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadSignatures(); }, [loadSignatures]);

  const accountSignatures = useMemo(
    () => signatures.filter((signature) => signature.accountId === accountId),
    [accountId, signatures],
  );

  const startCreate = () => {
    setEditingId(undefined);
    setDraft({ ...emptyDraft(), makeDefault: accountSignatures.length === 0 });
    setFeedback("");
  };

  const startEdit = (signature: ClientMailSignature) => {
    setEditingId(signature.id);
    setDraft({
      name: signature.name,
      fullText: signature.fullText,
      shortText: signature.shortText,
      makeDefault: signature.isDefault,
    });
    setFeedback("");
  };

  const save = async () => {
    if (!accountId || busy) return;
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch(editingId ? `/api/mail-signatures/${encodeURIComponent(editingId)}` : "/api/mail-signatures", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, ...draft }),
      });
      const payload = await response.json() as { readonly message?: string };
      if (!response.ok) throw new Error(payload.message || "无法保存签名版本");
      await loadSignatures();
      setEditingId(undefined);
      setDraft(emptyDraft());
      setFeedback("签名版本已保存");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存签名版本");
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (signature: ClientMailSignature) => {
    if (busy || signature.isDefault) return;
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch(`/api/mail-signatures/${encodeURIComponent(signature.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-default" }),
      });
      const payload = await response.json() as { readonly message?: string };
      if (!response.ok) throw new Error(payload.message || "无法设置默认签名");
      await loadSignatures();
      setFeedback(`“${signature.name}”已设为默认签名`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法设置默认签名");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (signature: ClientMailSignature) => {
    if (busy || !await appConfirm({
      title: `删除签名版本“${signature.name}”？`,
      description: "已经插入草稿的签名内容不会被删除，之后的新邮件将不再使用此版本。",
      confirmLabel: "删除版本",
      tone: "danger",
    })) return;
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch(`/api/mail-signatures/${encodeURIComponent(signature.id)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly message?: string };
      if (!response.ok) throw new Error(payload.message || "无法删除签名版本");
      if (editingId === signature.id) startCreate();
      await loadSignatures();
      setFeedback("签名版本已删除");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法删除签名版本");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mail-signature-settings panel" aria-labelledby="mail-signature-settings-title">
      <div className="settings-section-heading">
        <div>
          <h2 id="mail-signature-settings-title">自动签名</h2>
          <p>新邮件和线程中的第一次回复使用完整签名；后续回复使用简短签名。</p>
        </div>
        <button className="secondary-button" disabled={!accountId || busy} onClick={startCreate}><Plus size={14} />新建版本</button>
      </div>

      {accounts.length === 0 ? (
        <div className="accounts-empty"><Mail size={20} /><div><strong>尚无可用邮箱账户</strong><span>连接邮箱后即可为账户创建签名版本。</span></div></div>
      ) : (
        <>
          <label className="mail-signature-account-picker">
            <span>应用到邮箱账户</span>
            <AppSelect
              ariaLabel="签名所属邮箱账户"
              value={accountId}
              onValueChange={(value) => {
                setAccountId(value);
                setEditingId(undefined);
                setDraft(emptyDraft());
                setFeedback("");
              }}
              options={accounts.map((account) => ({
                value: account.id,
                label: `${account.displayName} <${account.emailAddress}>`,
              }))}
            />
          </label>

          <div className="mail-signature-layout">
            <div className="mail-signature-list" aria-label="签名版本">
              {loading ? (
                <div className="accounts-empty"><LoaderCircle className="spin" size={17} />正在读取签名…</div>
              ) : accountSignatures.length === 0 ? (
                <button className="mail-signature-empty" onClick={startCreate}>
                  <Plus size={18} /><span><strong>创建第一个签名版本</strong><small>分别准备完整和简短内容</small></span>
                </button>
              ) : accountSignatures.map((signature) => (
                <article className={`mail-signature-item ${editingId === signature.id ? "editing" : ""}`} key={signature.id}>
                  <button className="mail-signature-item-main" onClick={() => startEdit(signature)}>
                    <span><strong>{signature.name}</strong>{signature.isDefault && <em>默认</em>}</span>
                    <small>{signature.fullText.split("\n")[0] || "空签名"}</small>
                  </button>
                  <div>
                    {!signature.isDefault && <button aria-label={`设为默认：${signature.name}`} title="设为默认" disabled={busy} onClick={() => void setDefault(signature)}><Check size={14} /></button>}
                    <button aria-label={`编辑：${signature.name}`} title="编辑" disabled={busy} onClick={() => startEdit(signature)}><Pencil size={14} /></button>
                    <button className="danger-button" aria-label={`删除：${signature.name}`} title="删除" disabled={busy} onClick={() => void remove(signature)}><Trash2 size={14} /></button>
                  </div>
                </article>
              ))}
            </div>

            <div className="mail-signature-editor">
              <header>
                <div><strong>{editingId ? "编辑签名版本" : "新建签名版本"}</strong><span>完整与简短版本会按往来阶段自动选择</span></div>
              </header>
              <label><span>版本名称</span><input value={draft.name} maxLength={100} placeholder="例如：工作签名" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <div className="mail-signature-copy-grid">
                <label><span>完整签名</span><textarea value={draft.fullText} maxLength={20_000} placeholder={"此致\n姓名\n职位 · 机构\n电话 · 网站"} onChange={(event) => setDraft({ ...draft, fullText: event.target.value })} /></label>
                <label><span>简短签名</span><textarea value={draft.shortText} maxLength={10_000} placeholder={"谢谢\n姓名"} onChange={(event) => setDraft({ ...draft, shortText: event.target.value })} /></label>
              </div>
              <label className="secure-toggle"><input type="checkbox" checked={draft.makeDefault} onChange={(event) => setDraft({ ...draft, makeDefault: event.target.checked })} /><span>设为此邮箱账户的默认签名</span></label>
              <footer>
                <button className="ghost-button" disabled={busy} onClick={() => { setEditingId(undefined); setDraft(emptyDraft()); }}>清空</button>
                <button className="primary-button" disabled={busy || !draft.name.trim() || !draft.fullText.trim() || !draft.shortText.trim()} onClick={() => void save()}>
                  {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存签名
                </button>
              </footer>
            </div>
          </div>
        </>
      )}
      {feedback && <div className="account-feedback" aria-live="polite">{feedback}</div>}
    </section>
  );
}
