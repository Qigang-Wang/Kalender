"use client";

import { Eye, EyeOff, LoaderCircle, LockKeyhole, Mail, ShieldCheck, UserRound } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import { BrandLogo } from "@/components/brand-logo";

type AuthMode = "login" | "setup";

interface AuthPanelProps {
  readonly mode: AuthMode;
}

export function ChangePasswordPanel({ displayName }: { readonly displayName: string }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setFeedback("Neue, zweimal eingegebene Passwörter sind inkonsequent");
      return;
    }
    setBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, currentPassword, newPassword }),
      });
      const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || "Passwort kann nicht geändert werden");
      router.replace("/today");
      router.refresh();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Passwort kann nicht geändert werden");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-brand">
        <BrandLogo className="auth-brand-mark" />
        <div><strong>Dayline</strong><span>Quiet Intelligence</span></div>
      </section>
      <section className="auth-panel" aria-labelledby="change-password-title">
        <header>
          <div className="auth-panel-icon"><LockKeyhole size={19} /></div>
          <h1 id="change-password-title">Ändern Sie zuerst das erste Passwort</h1>
          <p>Der Administrator erstellt eine Kontonummer für Sie. Bevor Sie den Schreibtisch eingeben, ändern Sie das temporäre Passwort auf ein neues Passwort, das nur Sie kennen.</p>
        </header>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label><span>aktuelles Passwort</span><div className="auth-input"><LockKeyhole size={16} /><input autoComplete="current-password" type={showPassword ? "text" : "password"} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /><button type="button" aria-label={showPassword ? "verstecktes Passwort" : "Passwort anzeigen"} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
          <label><span>Neues Passwort</span><div className="auth-input"><LockKeyhole size={16} /><input autoComplete="new-password" type={showPassword ? "text" : "password"} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="mindestens 8 Zeichen" required /></div></label>
          <label><span>Bestätigung des neuen Passworts</span><div className="auth-input"><LockKeyhole size={16} /><input autoComplete="new-password" type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div></label>
          {feedback && <div className="auth-feedback" role="alert">{feedback}</div>}
          <button className="auth-submit" type="submit" disabled={busy || newPassword.length < 8}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{busy ? "Speichern..." : "Speichern und Betreten der Workstation"}</button>
        </form>
      </section>
    </main>
  );
}

export function InviteAcceptPanel({
  token,
  email,
  suggestedName,
}: {
  readonly token: string;
  readonly email: string;
  readonly suggestedName: string;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(suggestedName);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, displayName, password, confirmPassword }),
      });
      const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || "Einladung kann nicht angenommen werden");
      router.replace("/today");
      router.refresh();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Einladung kann nicht angenommen werden");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-brand">
        <BrandLogo className="auth-brand-mark" />
        <div><strong>Dayline</strong><span>Quiet Intelligence</span></div>
      </section>
      <section className="auth-panel" aria-labelledby="invite-title">
        <header>
          <div className="auth-panel-icon"><UserRound size={19} /></div>
          <h1 id="invite-title">Einladung des Schreibtisches annehmen</h1>
          <p>{email} Sie sind eingeladen, an dieser Workstation teilzunehmen. Das Passwort ist so eingestellt, dass Sie Ihren Speicherplatz eingeben können.</p>
        </header>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label><span>Nickname</span><div className="auth-input"><UserRound size={16} /><input autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></div></label>
          <label><span>Passwort</span><div className="auth-input"><LockKeyhole size={16} /><input autoComplete="new-password" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="mindestens 8 Zeichen" required /><button type="button" aria-label={showPassword ? "verstecktes Passwort" : "Passwort anzeigen"} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
          <label><span>Passwort bestätigen</span><div className="auth-input"><LockKeyhole size={16} /><input autoComplete="new-password" type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div></label>
          {feedback && <div className="auth-feedback" role="alert">{feedback}</div>}
          <button className="auth-submit" type="submit" disabled={busy || displayName.trim().length < 2 || password.length < 8}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{busy ? "Hinzufügen..." : "Workstation hinzufügen"}</button>
        </form>
      </section>
    </main>
  );
}

export function AuthPanel({ mode }: AuthPanelProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const nextPath = useMemo(() => safeNextPath(searchParams.get("next")), [searchParams]);
  const isSetup = mode === "setup";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch(isSetup ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isSetup ? { displayName, email, password, confirmPassword } : { email, password, remember }),
      });
      const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || (isSetup ? "Initialisierung fehlgeschlagen" : "Anmeldung fehlgeschlagen"));
      router.replace(nextPath);
      router.refresh();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : (isSetup ? "Initialisierung fehlgeschlagen" : "Anmeldung fehlgeschlagen"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-brand">
        <BrandLogo className="auth-brand-mark" />
        <div>
          <strong>Dayline</strong>
          <span>Quiet Intelligence</span>
        </div>
      </section>

      <section className="auth-panel" aria-labelledby="auth-title">
        <header>
          <div className="auth-panel-icon"><LockKeyhole size={19} /></div>
          <h1 id="auth-title">{isSetup ? "Kontonummer des Administrators erstellen" : "Melden Sie sich an Ihrer Workstation an"}</h1>
          <p>{isSetup ? "Schützen Sie die Workstation, bevor Sie den Postfach-, Kalender- und KI-Service eingeben." : "Verwenden Sie ein Desktop-Konto, um auf Ihre E-Mail, Kalender, Aufgaben und Notizen Platz zugreifen."}</p>
        </header>

        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {isSetup && (
            <label>
              <span>Nickname</span>
              <div className="auth-input">
                <UserRound size={16} />
                <input
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Ihr Name"
                  required
                />
              </div>
            </label>
          )}

          <label>
            <span>Postfach-Adresse</span>
            <div className="auth-input">
              <Mail size={16} />
              <input
                autoComplete="email"
                inputMode="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
            </div>
          </label>

          <label>
            <span>Passwort</span>
            <div className="auth-input">
              <LockKeyhole size={16} />
              <input
                autoComplete={isSetup ? "new-password" : "current-password"}
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={isSetup ? "mindestens 8 Zeichen" : "Passwort eingeben"}
                required
              />
              <button type="button" aria-label={showPassword ? "verstecktes Passwort" : "Passwort anzeigen"} onClick={() => setShowPassword((value) => !value)}>
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </label>

          {isSetup && (
            <label>
              <span>Passwort bestätigen</span>
              <div className="auth-input">
                <LockKeyhole size={16} />
                <input
                  autoComplete="new-password"
                  type={showPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Passwort erneut eingeben"
                  required
                />
              </div>
            </label>
          )}

          {feedback && <div className="auth-feedback" role="alert">{feedback}</div>}

          {!isSetup && (
            <label className="auth-remember">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              <span>30 Tage für die Aufrechterhaltung der Anmeldung</span>
            </label>
          )}

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
            {isSetup ? "Erstellen und Betreten der Workstation" : "Anmelden"}
          </button>
        </form>
      </section>

      <aside className="auth-context" aria-label="Beschreibung des Logins">
        <div><strong>Priorität des lokalen Kontos</strong><span>Konfigurieren Sie Postfächer, Kalender und AI-Anbieter nach der Eingabe der Workstation.</span></div>
        <div><strong>Privater Standard</strong><span>Die Initialisierung ist nur ohne Administratorkonto erlaubt; die öffentliche Registrierung wird dann geschlossen.</span></div>
        <div><strong>klare Genehmigung</strong><span>Externe Service-Verbindungen und Schreiben werden weiterhin vom Benutzer bestätigt.</span></div>
      </aside>
    </main>
  );
}

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/today";
  if (value.startsWith("/login") || value.startsWith("/setup")) return "/today";
  return value;
}
