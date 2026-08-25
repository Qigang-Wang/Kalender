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
      if (!response.ok) throw new Error(payload.message || "E-Mail-Signatur kann nicht gelesen werden");
      setSignatures(payload.signatures ?? []);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "E-Mail-Signatur kann nicht gelesen werden");
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
      if (!response.ok) throw new Error(payload.message || "Signaturversion konnte nicht gespeichert werden");
      await loadSignatures();
      setEditingId(undefined);
      setDraft(emptyDraft());
      setFeedback("Signatur-Version gespeichert");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Signaturversion konnte nicht gespeichert werden");
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
      if (!response.ok) throw new Error(payload.message || "Standardsignatur kann nicht gesetzt werden");
      await loadSignatures();
      setFeedback(`„${signature.name}“ wurde als Standardsignatur festgelegt`);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Standardsignatur kann nicht gesetzt werden");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (signature: ClientMailSignature) => {
    if (busy || !await appConfirm({
      title: `Signaturversion „${signature.name}“ löschen?`,
      description: "Bereits in Entwürfe eingefügte Signaturen bleiben erhalten. Für neue E-Mails wird diese Version nicht mehr verwendet.",
      confirmLabel: "Version löschen",
      tone: "danger",
    })) return;
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch(`/api/mail-signatures/${encodeURIComponent(signature.id)}`, { method: "DELETE" });
      const payload = await response.json() as { readonly message?: string };
      if (!response.ok) throw new Error(payload.message || "Signaturversion konnte nicht gelöscht werden");
      if (editingId === signature.id) startCreate();
      await loadSignatures();
      setFeedback("Signatur-Version gelöscht");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Signaturversion konnte nicht gelöscht werden");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mail-signature-settings panel" aria-labelledby="mail-signature-settings-title">
      <div className="settings-section-heading">
        <div>
          <h2 id="mail-signature-settings-title">automatische Signatur</h2>
          <p>Die erste Antwort in der neuen Mail und Thread ist in ihrer Gesamtheit signiert; die Folgereaktion wird in einer kurzen Weise unterzeichnet.</p>
        </div>
        <button className="secondary-button" disabled={!accountId || busy} onClick={startCreate}><Plus size={14} />Neue Version</button>
      </div>

      {accounts.length === 0 ? (
        <div className="accounts-empty"><Mail size={20} /><div><strong>noch kein Postfach-Konto verfügbar</strong><span>Sie können eine Signaturversion für ein Konto erstellen, wenn Sie sich mit dem Postfach verbinden.</span></div></div>
      ) : (
        <>
          <label className="mail-signature-account-picker">
            <span>auf Postfachkonten angewendet</span>
            <AppSelect
              ariaLabel="Unterzeichnung des Postkontos, zu dem es gehört"
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
            <div className="mail-signature-list" aria-label="Unterschriftsversion">
              {loading ? (
                <div className="accounts-empty"><LoaderCircle className="spin" size={17} />Unterschrift lesen...</div>
              ) : accountSignatures.length === 0 ? (
                <button className="mail-signature-empty" onClick={startCreate}>
                  <Plus size={18} /><span><strong>erste Signatur-Version erstellen</strong><small>Vorbereitung vollständiger bzw. kurzer Inhalte</small></span>
                </button>
              ) : accountSignatures.map((signature) => (
                <article className={`mail-signature-item ${editingId === signature.id ? "editing" : ""}`} key={signature.id}>
                  <button className="mail-signature-item-main" onClick={() => startEdit(signature)}>
                    <span><strong>{signature.name}</strong>{signature.isDefault && <em>Standard</em>}</span>
                    <small>{signature.fullText.split("\n")[0] || "Leere Signatur"}</small>
                  </button>
                  <div>
                    {!signature.isDefault && <button aria-label={`Als Standardeinstellung festlegen:${signature.name}`} title="Als Standardeinstellung festlegen" disabled={busy} onClick={() => void setDefault(signature)}><Check size={14} /></button>}
                    <button aria-label={`Bearbeiten:${signature.name}`} title="Bearbeiten" disabled={busy} onClick={() => startEdit(signature)}><Pencil size={14} /></button>
                    <button className="danger-button" aria-label={`Löschen:${signature.name}`} title="Löschen" disabled={busy} onClick={() => void remove(signature)}><Trash2 size={14} /></button>
                  </div>
                </article>
              ))}
            </div>

            <div className="mail-signature-editor">
              <header>
                <div><strong>{editingId ? "Signaturversion bearbeiten" : "Neue Signaturversion"}</strong><span>komplette und kurze Versionen werden automatisch im Transaktionsstadium ausgewählt</span></div>
              </header>
              <label><span>Bezeichnung der Version</span><input value={draft.name} maxLength={100} placeholder="z.B. Arbeitsunterschrift" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <div className="mail-signature-copy-grid">
                <label><span>vollständige Unterschrift</span><textarea value={draft.fullText} maxLength={20_000} placeholder={"Hier ist der Name, die Position, die Agentur, das Telefon, die Website."} onChange={(event) => setDraft({ ...draft, fullText: event.target.value })} /></label>
                <label><span>kurze Unterschrift</span><textarea value={draft.shortText} maxLength={10_000} placeholder={"Vielen Dank. Name"} onChange={(event) => setDraft({ ...draft, shortText: event.target.value })} /></label>
              </div>
              <label className="secure-toggle"><input type="checkbox" checked={draft.makeDefault} onChange={(event) => setDraft({ ...draft, makeDefault: event.target.checked })} /><span>der Standard-Signatursatz für dieses Postfach-Konto</span></label>
              <footer>
                <button className="ghost-button" disabled={busy} onClick={() => { setEditingId(undefined); setDraft(emptyDraft()); }}>leer</button>
                <button className="primary-button" disabled={busy || !draft.name.trim() || !draft.fullText.trim() || !draft.shortText.trim()} onClick={() => void save()}>
                  {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Signatur speichern
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
