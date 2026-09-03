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
  const [testing, setTesting] = useState(false);
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
        .catch(() => setFeedback("无法读取桌面客户端状态"));
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
      setFeedback("桌面客户端设置已保存");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法保存桌面客户端设置");
    } finally {
      setSaving(false);
    }
  };

  const sendTestNotification = async () => {
    setTesting(true);
    setFeedback("");
    try {
      await invokeDesktop<void>("send_test_notification");
      setFeedback("测试通知已发送");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法发送测试通知");
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="desktop-reminder-settings panel" aria-labelledby="desktop-reminder-settings-title">
      <div className="settings-section-heading">
        <div>
          <h2 id="desktop-reminder-settings-title">桌面客户端</h2>
          <p>管理本机通知、启动方式和托盘行为。</p>
        </div>
        <span className={`desktop-runtime-status ${desktopAvailable ? "connected" : "browser"}`}>
          <i />{desktopAvailable ? "桌面客户端已连接" : "当前为网页版本"}
        </span>
      </div>

      {!desktopAvailable && <div className="desktop-settings-notice"><MonitorDown size={17} /><span>请在 Kalender 桌面客户端中打开此页面后设置。</span></div>}

      <section className="desktop-settings-group" aria-labelledby="desktop-notification-settings-title">
        <h3 id="desktop-notification-settings-title">通知与提醒</h3>
        <div className="desktop-settings-list" aria-disabled={!desktopAvailable}>
          <SettingToggle icon={<BellRing size={16} />} title="桌面通知" description="为同步到本机的日程发送系统通知" checked={draft.enabled} disabled={!desktopAvailable} onChange={(enabled) => setDraft({ ...draft, enabled })} />
          <SettingSelect icon={<Clock3 size={16} />} title="默认提前提醒" description="适用于没有单独提醒规则的普通日程" value={draft.reminderMinutesBefore} disabled={!desktopAvailable || !draft.enabled} options={[{ value: 0, label: "准时" }, { value: 5, label: "5 分钟" }, { value: 10, label: "10 分钟" }, { value: 15, label: "15 分钟" }, { value: 30, label: "30 分钟" }, { value: 60, label: "1 小时" }]} onChange={(reminderMinutesBefore) => setDraft({ ...draft, reminderMinutesBefore })} />
          <SettingSelect icon={<CalendarDays size={16} />} title="全天日程提醒" description="全天日程在当天的这个时间发送通知" value={draft.allDayReminderHour} disabled={!desktopAvailable || !draft.enabled} options={[{ value: 7, label: "07:00" }, { value: 8, label: "08:00" }, { value: 9, label: "09:00" }, { value: 10, label: "10:00" }, { value: 12, label: "12:00" }]} onChange={(allDayReminderHour) => setDraft({ ...draft, allDayReminderHour })} />
          <SettingSelect icon={<RefreshCw size={16} />} title="补发错过的提醒" description="系统休眠恢复后，只补发这个时间范围内的提醒" value={draft.missedReminderWindowMinutes} disabled={!desktopAvailable || !draft.enabled} options={[{ value: 0, label: "不补发" }, { value: 15, label: "15 分钟" }, { value: 30, label: "30 分钟" }, { value: 60, label: "1 小时" }, { value: 180, label: "3 小时" }]} onChange={(missedReminderWindowMinutes) => setDraft({ ...draft, missedReminderWindowMinutes })} />
        </div>
      </section>

      <section className="desktop-settings-group" aria-labelledby="desktop-behavior-settings-title">
        <h3 id="desktop-behavior-settings-title">应用与托盘</h3>
        <div className="desktop-settings-list" aria-disabled={!desktopAvailable}>
          <SettingToggle icon={<Power size={16} />} title="开机启动" description="登录系统后在托盘中启动 Kalender" checked={draft.launchAtLogin} disabled={!desktopAvailable} onChange={(launchAtLogin) => setDraft({ ...draft, launchAtLogin })} />
          <SettingToggle icon={<MonitorDown size={16} />} title="关闭后驻留" description="关闭主窗口时隐藏到托盘并继续提醒" checked={draft.minimizeToTray} disabled={!desktopAvailable} onChange={(minimizeToTray) => setDraft({ ...draft, minimizeToTray })} />
          <SettingToggle icon={<Eye size={16} />} title="显示下一项标题" description="在托盘悬停提示中显示下一项日程名称" checked={draft.showEventTitle} disabled={!desktopAvailable} onChange={(showEventTitle) => setDraft({ ...draft, showEventTitle })} />
        </div>
      </section>

      <footer className="sync-settings-actions">
        <span>{feedback || desktopStatusText(status, desktopAvailable)}</span>
        <button type="button" className="secondary-button" disabled={!desktopAvailable || testing} onClick={() => void sendTestNotification()}>{testing ? "发送中…" : "发送测试通知"}</button>
        <button type="button" className="primary-button" disabled={!desktopAvailable || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存设置"}</button>
      </footer>
    </section>
  );
}

function desktopStatusText(status: DesktopStatus | undefined, desktopAvailable: boolean): string {
  if (!desktopAvailable) return "网页版无法修改桌面客户端设置";
  if (!status) return "正在读取本机提醒状态";
  if (status.lastSyncError) return `日历同步失败：${status.lastSyncError}`;
  if (!status.lastSyncedAt) return "等待首次日历同步";
  return `本机队列中有 ${status.queuedReminderCount} 个待处理提醒`;
}

function SettingToggle({ icon, title, description, checked, disabled, onChange }: { readonly icon: ReactNode; readonly title: string; readonly description: string; readonly checked: boolean; readonly disabled: boolean; readonly onChange: (checked: boolean) => void }) {
  return <div className="desktop-settings-row"><span className="desktop-settings-icon">{icon}</span><span className="desktop-settings-copy"><strong>{title}</strong><small>{description}</small></span><label className="sync-settings-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true"><i /></span><em>{checked ? "开启" : "关闭"}</em></label></div>;
}

function SettingSelect({ icon, title, description, value, options, disabled, onChange }: { readonly icon: ReactNode; readonly title: string; readonly description: string; readonly value: number; readonly options: readonly { readonly value: number; readonly label: string }[]; readonly disabled: boolean; readonly onChange: (value: number) => void }) {
  return <div className="desktop-settings-row"><span className="desktop-settings-icon">{icon}</span><span className="desktop-settings-copy"><strong>{title}</strong><small>{description}</small></span><AppSelect className="desktop-settings-select" ariaLabel={title} size="compact" value={String(value)} disabled={disabled} onValueChange={(next) => onChange(Number(next))} options={options.map((option) => ({ value: String(option.value), label: option.label }))} /></div>;
}
