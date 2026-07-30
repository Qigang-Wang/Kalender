import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { ensureCalendarSyncScheduler } from "@/server/calendar-sync-scheduler";
import { ensureMailSyncScheduler } from "@/server/mail-sync-scheduler";
import {
  getWorkspaceSyncSettings,
  saveWorkspaceSyncSettings,
  SyncSettingsError,
  type WorkspaceSyncSettingsInput,
} from "@/server/sync-settings";

export const runtime = "nodejs";

export async function GET() {
  try {
    const actor = await requireActor();
    const settings = await getWorkspaceSyncSettings();
    const [mailScheduler, calendarScheduler] = await Promise.all([
      ensureMailSyncScheduler(settings),
      ensureCalendarSyncScheduler(settings),
    ]);
    return NextResponse.json({
      ok: true,
      settings,
      canEdit: actor.role === "admin",
      schedulers: { mail: mailScheduler, calendar: calendarScheduler },
    });
  } catch (error) {
    return syncSettingsErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const actor = await requireActor();
    const body = await request.json().catch(() => null) as Partial<WorkspaceSyncSettingsInput> | null;
    if (!body) throw new SyncSettingsError("同步设置格式无效");
    const settings = await saveWorkspaceSyncSettings(actor, {
      mailSyncEnabled: body.mailSyncEnabled === true,
      mailSyncIntervalMs: Number(body.mailSyncIntervalMs),
      calendarSyncEnabled: body.calendarSyncEnabled === true,
      calendarSyncIntervalMs: Number(body.calendarSyncIntervalMs),
      clientRefreshEnabled: body.clientRefreshEnabled === true,
      clientRefreshIntervalMs: Number(body.clientRefreshIntervalMs),
    });
    const [mailScheduler, calendarScheduler] = await Promise.all([
      ensureMailSyncScheduler(settings),
      ensureCalendarSyncScheduler(settings),
    ]);
    return NextResponse.json({
      ok: true,
      settings,
      canEdit: true,
      schedulers: { mail: mailScheduler, calendar: calendarScheduler },
    });
  } catch (error) {
    return syncSettingsErrorResponse(error);
  }
}

async function requireActor() {
  const actor = await getCurrentAppUser();
  if (!actor) throw new AuthError("请先登录", 401);
  return actor;
}

function syncSettingsErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError || error instanceof SyncSettingsError
    ? error
    : new SyncSettingsError("无法保存同步设置", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
