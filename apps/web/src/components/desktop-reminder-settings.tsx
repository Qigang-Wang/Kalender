"use client";

import { BellRing, CalendarDays, Clock3, Eye, MonitorDown, Power, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { AppSelect } from "@/components/app-select";
import {
  DEFAULT_DESKTOP_REMINDER_SETTINGS,
  invokeDesktop,
  isDesktopApp,
  readDesktopReminderSettings,
  saveDesktopReminderSettings,
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
    const available = isDesktopApp();
    setDesktopAvailable(available);
    if (available) {
      void invokeDesktop<DesktopStatus>("desktop_status")
        .then(setStatus)
        .catch(() => setFeedback("无法读取桌面客户端状态"));
    }
  }, []);

  const save = async () => {
    setSaving(true);
    setFeedback("");
    try {
      const normalized = saveDesktopReminderSettings(draft);
      const nextStatus = await invokeDesktop<DesktopStatus>("update_desktop_settings", { settings: normalized });
      setDraft(normalized);
      setStatus(nextStatus);
      setFeedback("桌面提醒设置已保存");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存桌面提醒设置");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="desktop-reminder-settings panel" aria-labelledby="desktop-reminder-settings-title">
      <div className="settings-section-heading">
        <div>
          <h2 id="desktop-reminder-settings-title">桌面提醒</h2>
          <p>通知由本机调度，即使 Kalender 窗口隐藏也会按时提醒。</p>
        </div>
        <span className={`desktop-runtime-status ${desktopAvailable ? "connected" : "browser"}`}>
          <i />{desktopAvailable ? "桌面客户端已连接" : "当前为网页版本"}
        </span>
      </div>

      {!desktopAvailable && <div className="desktop-settings-notice"><MonitorDown size={17} /><span>这些选项需要在 Kalender 桌面客户端中设置。</span></div>}

      <div className="desktop-settings-list" aria-disabled={!desktopAvailable}>
        <SettingToggle icon={<BellRing size={16} />} title="桌面通知" description="为同步到本机的日程发送系统通知" checked={draft.enabled} disabled={!desktopAvailable} onChange={(enabled) => setDraft({ ...draft, enabled })} />
        <SettingSelect icon={<Clock3 size={16} />} title="默认提前提醒" description="适用于没有单独提醒规则的普通日程" value={draft.reminderMinutesBefore} disabled={!desktopAvailable || !draft.enabled} options={[{ value: 0, label: "准时" }, { value: 5, label: "5 分钟" }, { value: 10, label: "10 分钟" }, { value: 15, label: "15 分钟" }, { value: 30, label: "30 分钟" }, { value: 60, label: "1 小时" }]} onChange={(reminderMinutesBefore) => setDraft({ ...draft, reminderMinutesBefore })} />
        <SettingSelect icon={<CalendarDays size={16} />} title="全天日程提醒" description="全天日程在当天的这个时间发送通知" value={draft.allDayReminderHour} disabled={!desktopAvailable || !draft.enabled} options={[{ value: 7, label: "07:00" }, { value: 8, label: "08:00" }, { value: 9, label: "09:00" }, { value: 10, label: "10:00" }, { value: 12, label: "12:00" }]} onChange={(allDayReminderHour) => setDraft({ ...draft, allDayReminderHour })} />
        <SettingToggle icon={<Power size={16} />} title="开机启动" description="登录系统后在托盘中启动 Kalender" checked={draft.launchAtLogin} disabled={!desktopAvailable} onChange={(launchAtLogin) => setDraft({ ...draft, launchAtLogin })} />
        <SettingToggle icon={<MonitorDown size={16} />} title="关闭后驻留" description="关闭主窗口时隐藏到托盘并继续提醒" checked={draft.minimizeToTray} disabled={!desktopAvailable} onChange={(minimizeToTray) => setDraft({ ...draft, minimizeToTray })} />
        <SettingToggle icon={<Eye size={16} />} title="显示下一项标题" description="在托盘悬停提示中显示下一项日程名称" checked={draft.showEventTitle} disabled={!desktopAvailable} onChange={(showEventTitle) => setDraft({ ...draft, showEventTitle })} />
        <SettingSelect icon={<RefreshCw size={16} />} title="补发错过的提醒" description="系统休眠恢复后，只补发这个时间范围内的提醒" value={draft.missedReminderWindowMinutes} disabled={!desktopAvailable || !draft.enabled} options={[{ value: 0, label: "不补发" }, { value: 15, label: "15 分钟" }, { value: 30, label: "30 分钟" }, { value: 60, label: "1 小时" }, { value: 180, label: "3 小时" }]} onChange={(missedReminderWindowMinutes) => setDraft({ ...draft, missedReminderWindowMinutes })} />
      </div>

      <footer className="sync-settings-actions">
        <span>{feedback || (status ? `本机队列中有 ${status.queuedReminderCount} 个待处理提醒` : "设置只保存在当前设备")}</span>
        <button type="button" className="primary-button" disabled={!desktopAvailable || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存设置"}</button>
      </footer>
    </section>
  );
}

function SettingToggle({ icon, title, description, checked, disabled, onChange }: { readonly icon: ReactNode; readonly title: string; readonly description: string; readonly checked: boolean; readonly disabled: boolean; readonly onChange: (checked: boolean) => void }) {
  return <div className="desktop-settings-row"><span className="desktop-settings-icon">{icon}</span><span className="desktop-settings-copy"><strong>{title}</strong><small>{description}</small></span><label className="sync-settings-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true"><i /></span><em>{checked ? "开启" : "关闭"}</em></label></div>;
}

function SettingSelect({ icon, title, description, value, options, disabled, onChange }: { readonly icon: ReactNode; readonly title: string; readonly description: string; readonly value: number; readonly options: readonly { readonly value: number; readonly label: string }[]; readonly disabled: boolean; readonly onChange: (value: number) => void }) {
  return <div className="desktop-settings-row"><span className="desktop-settings-icon">{icon}</span><span className="desktop-settings-copy"><strong>{title}</strong><small>{description}</small></span><AppSelect className="desktop-settings-select" ariaLabel={title} size="compact" value={String(value)} disabled={disabled} onValueChange={(next) => onChange(Number(next))} options={options.map((option) => ({ value: String(option.value), label: option.label }))} /></div>;
}
