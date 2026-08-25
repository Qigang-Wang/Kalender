"use client";

import { BellRing, CalendarDays, Clock3, Eye, MonitorDown, Power, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { AppSelect } from "@/components/app-select";
import {
  DEFAULT_DESKTOP_REMINDER_SETTINGS,
  DESKTOP_STATUS_CHANGED_EVENT,
  invokeDesktop,
  publishDesktopStatus,
  readDesktopReminderSettings,
  saveDesktopReminderSettings,
  waitForDesktopApp,
  type DesktopReminderSettings,
  type DesktopStatus,
} from "@/lib/desktop-bridge";

export function DesktopReminderSettingsPanel() {
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  const [draft, setDraft] = useState<DesktopReminderSettings>(DEFAULT_DESKTOP_REMINDER_SETTINGS);
  const [status, setStatus] = useState<DesktopStatus>();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    setDraft(readDesktopReminderSettings());
    let disposed = false;
    const handleStatus = (event: Event) => setStatus((event as CustomEvent<DesktopStatus>).detail);
    window.addEventListener(DESKTOP_STATUS_CHANGED_EVENT, handleStatus);
    void waitForDesktopApp().then((available) => {
      if (disposed) return;
      setDesktopAvailable(available);
      if (!available) return;
      void invokeDesktop<DesktopStatus>("desktop_status")
        .then((nextStatus) => {
          setStatus(nextStatus);
          publishDesktopStatus(nextStatus);
        })
        .catch(() => setFeedback("Desktop-Client-Status kann nicht gelesen werden"));
    });
    return () => {
      disposed = true;
      window.removeEventListener(DESKTOP_STATUS_CHANGED_EVENT, handleStatus);
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setFeedback("");
    try {
      const normalized = saveDesktopReminderSettings(draft);
      const nextStatus = await invokeDesktop<DesktopStatus>("update_desktop_settings", { settings: normalized });
      setDraft(normalized);
      setStatus(nextStatus);
      setFeedback("Desktop-Client-Einstellungen gespeichert");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Desktop-Client-Einstellungen können nicht gespeichert werden");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="desktop-reminder-settings panel" aria-labelledby="desktop-reminder-settings-title">
      <div className="settings-section-heading">
        <div>
          <h2 id="desktop-reminder-settings-title">Desktop-Client</h2>
          <p>Verwaltet die Benachrichtigung an Bord, den Start-up-Modus und das Tray-Verhalten.</p>
        </div>
        <span className={`desktop-runtime-status ${desktopAvailable ? "connected" : "browser"}`}>
          <i />{desktopAvailable ? "Desktop-Client verbunden" : "Derzeit Web-Version"}
        </span>
      </div>

      {!desktopAvailable && <div className="desktop-settings-notice"><MonitorDown size={17} /><span>Bitte öffnen Sie diese Seite nach dem Einrichten im Kalender-Desktop-Client.</span></div>}

      <section className="desktop-settings-group" aria-labelledby="desktop-notification-settings-title">
        <h3 id="desktop-notification-settings-title">Benachrichtigungen und Mahnungen</h3>
        <div className="desktop-settings-list" aria-disabled={!desktopAvailable}>
          <SettingToggle icon={<BellRing size={16} />} title="Desktop-Benachrichtigungen" description="Systembenachrichtigungen für synchronisierte Termine anzeigen" checked={draft.enabled} disabled={!desktopAvailable} onChange={(enabled) => setDraft({ ...draft, enabled })} />
          <SettingSelect icon={<Clock3 size={16} />} title="Standard-Voraberinnerung" description="ein normales Kalenderereignis, das keine gesonderte Erinnerungsregel hat" value={draft.reminderMinutesBefore} disabled={!desktopAvailable || !draft.enabled} options={[{ value: 0, label: "rechtzeitig" }, { value: 5, label: "5 Minuten" }, { value: 10, label: "10 Minuten" }, { value: 15, label: "15 Minuten" }, { value: 30, label: "30 Minuten" }, { value: 60, label: "1 Stunde" }]} onChange={(reminderMinutesBefore) => setDraft({ ...draft, reminderMinutesBefore })} />
          <SettingSelect icon={<CalendarDays size={16} />} title="Ganztags-Kalenderveranstaltung Erinnerung" description="Die Ganztags-Kalenderveranstaltung sendet die Mitteilung zu dieser Tageszeit" value={draft.allDayReminderHour} disabled={!desktopAvailable || !draft.enabled} options={[{ value: 7, label: "07:00" }, { value: 8, label: "08:00" }, { value: 9, label: "09:00" }, { value: 10, label: "10:00" }, { value: 12, label: "12:00" }]} onChange={(allDayReminderHour) => setDraft({ ...draft, allDayReminderHour })} />
          <SettingSelect icon={<RefreshCw size={16} />} title="Cascade vermisst Erinnerungen" description="nachdem Systemüberwinterung wiederhergestellt ist, werden nur Erinnerungen innerhalb dieses Zeitrahmens neu ausgegeben" value={draft.missedReminderWindowMinutes} disabled={!desktopAvailable || !draft.enabled} options={[{ value: 0, label: "keine Weiterverbreitung" }, { value: 15, label: "15 Minuten" }, { value: 30, label: "30 Minuten" }, { value: 60, label: "1 Stunde" }, { value: 180, label: "3 Stunden" }]} onChange={(missedReminderWindowMinutes) => setDraft({ ...draft, missedReminderWindowMinutes })} />
        </div>
      </section>

      <section className="desktop-settings-group" aria-labelledby="desktop-behavior-settings-title">
        <h3 id="desktop-behavior-settings-title">Anwendung und Tablett</h3>
        <div className="desktop-settings-list" aria-disabled={!desktopAvailable}>
          <SettingToggle icon={<Power size={16} />} title="Start-up" description="Kalender nach dem Login im Tray starten" checked={draft.launchAtLogin} disabled={!desktopAvailable} onChange={(launchAtLogin) => setDraft({ ...draft, launchAtLogin })} />
          <SettingToggle icon={<MonitorDown size={16} />} title="nach dem Schließen bleiben" description="Verstecken Sie sich in Tray und weitere Erinnerung, wenn das Hauptfenster schließt" checked={draft.minimizeToTray} disabled={!desktopAvailable} onChange={(minimizeToTray) => setDraft({ ...draft, minimizeToTray })} />
          <SettingToggle icon={<Eye size={16} />} title="Titel des nächsten Termins anzeigen" description="Den Namen des nächsten Termins im Infobereich anzeigen" checked={draft.showEventTitle} disabled={!desktopAvailable} onChange={(showEventTitle) => setDraft({ ...draft, showEventTitle })} />
        </div>
      </section>

      <footer className="sync-settings-actions">
        <span>{feedback || desktopStatusText(status, desktopAvailable)}</span>
        <button type="button" className="primary-button" disabled={!desktopAvailable || saving} onClick={() => void save()}>{saving ? "Speichern..." : "Einstellungen speichern"}</button>
      </footer>
    </section>
  );
}

function desktopStatusText(status: DesktopStatus | undefined, desktopAvailable: boolean): string {
  if (!desktopAvailable) return "Web-Version kann Desktop-Client-Einstellungen nicht ändern";
  if (!status) return "Lesen dieser Maschine Alarmzustand";
  if (status.lastSyncError) return `Kalendersynchronisierung fehlgeschlagen:${status.lastSyncError}`;
  if (!status.lastSyncedAt) return "warten auf den ersten Kalender synchronisieren";
  return `in dieser Warteschlange ${status.queuedReminderCount} eine Erinnerung an die Verarbeitung`;
}

function SettingToggle({ icon, title, description, checked, disabled, onChange }: { readonly icon: ReactNode; readonly title: string; readonly description: string; readonly checked: boolean; readonly disabled: boolean; readonly onChange: (checked: boolean) => void }) {
  return <div className="desktop-settings-row"><span className="desktop-settings-icon">{icon}</span><span className="desktop-settings-copy"><strong>{title}</strong><small>{description}</small></span><label className="sync-settings-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true"><i /></span><em>{checked ? "Aktivieren" : "Schließen"}</em></label></div>;
}

function SettingSelect({ icon, title, description, value, options, disabled, onChange }: { readonly icon: ReactNode; readonly title: string; readonly description: string; readonly value: number; readonly options: readonly { readonly value: number; readonly label: string }[]; readonly disabled: boolean; readonly onChange: (value: number) => void }) {
  return <div className="desktop-settings-row"><span className="desktop-settings-icon">{icon}</span><span className="desktop-settings-copy"><strong>{title}</strong><small>{description}</small></span><AppSelect className="desktop-settings-select" ariaLabel={title} size="compact" value={String(value)} disabled={disabled} onValueChange={(next) => onChange(Number(next))} options={options.map((option) => ({ value: String(option.value), label: option.label }))} /></div>;
}
