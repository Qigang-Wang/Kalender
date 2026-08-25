"use client";

import { AlertCircle, CheckCircle2, Circle, X } from "lucide-react";
import { useEffect, useRef, type CSSProperties } from "react";

type TransientToastKind = "success" | "error" | "info";

function inferTransientToastKind(message: string): TransientToastKind {
  if (/konnte nicht|fehlgeschlagen|fehler|konflikt|nicht möglich|nicht gefunden|nicht vorhanden|ungültig|abgelehnt|bitte (?:zuerst|mindestens|geben)|muss später|nicht verfügbar|keine Schreibberechtigung/i.test(message)) return "error";
  if (/^(?:gespeichert|erstellt|aktualisiert|gelöscht|synchronisiert|verschoben|archiviert|wiederhergestellt|erledigt|erfolgreich)|\b(?:wurde|wurden|ist|sind) (?:gespeichert|erstellt|aktualisiert|gelöscht|synchronisiert|verschoben|archiviert|wiederhergestellt)\b/i.test(message)) return "success";
  return "info";
}

export function TransientToast({
  message,
  onClose,
  duration = 3_000,
  testId,
}: {
  readonly message: string;
  readonly onClose: () => void;
  readonly duration?: number;
  readonly testId?: string;
}) {
  const onCloseRef = useRef(onClose);
  const kind = inferTransientToastKind(message);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const timer = window.setTimeout(() => onCloseRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [duration, message]);

  return <div
    className={`app-toast ${kind}`}
    data-testid={testId}
    key={message}
    role={kind === "error" ? "alert" : "status"}
    aria-live={kind === "error" ? "assertive" : "polite"}
    style={{ "--toast-duration": `${duration}ms` } as CSSProperties}
  >
    {kind === "success" ? <CheckCircle2 size={16} /> : kind === "error" ? <AlertCircle size={16} /> : <Circle size={14} />}
    <span>{message}</span>
    <button type="button" aria-label="Schalten Sie den Hinweis aus" onClick={onClose}><X size={13} /></button>
  </div>;
}
