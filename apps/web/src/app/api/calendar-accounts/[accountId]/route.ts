import { NextResponse } from "next/server";

import { deleteCalendarAccount, getCalendarAccount, updateCalendarAccountSettings, updateExchangeFeatureSettings } from "@/server/calendar-account-repository";

export const runtime = "nodejs";

interface CalendarAccountRouteContext {
  readonly params: Promise<{ readonly accountId: string }>;
}

export async function PATCH(request: Request, context: CalendarAccountRouteContext) {
  const { accountId } = await context.params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (typeof body?.mailEnabled === "boolean" && typeof body.calendarEnabled === "boolean") {
    let account = await updateExchangeFeatureSettings(accountId, {
      mailEnabled: body.mailEnabled,
      calendarEnabled: body.calendarEnabled,
    });
    const featureDisplayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const featureColor = typeof body.color === "string" ? body.color.trim().toLowerCase() : "";
    const featureEmail = typeof body.emailAddress === "string" ? body.emailAddress.trim().toLocaleLowerCase() : undefined;
    if (featureEmail !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(featureEmail)) {
      return NextResponse.json({ ok: false, message: "请输入有效的正式邮箱地址" }, { status: 400 });
    }
    if (account && featureDisplayName && /^#[0-9a-f]{6}$/.test(featureColor)) {
      account = await updateCalendarAccountSettings(accountId, { displayName: featureDisplayName, color: featureColor, emailAddress: featureEmail });
    }
    return account
      ? NextResponse.json({ ok: true, account })
      : NextResponse.json({ ok: false, message: "Exchange 账户不存在" }, { status: 404 });
  }
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  const color = typeof body?.color === "string" ? body.color.trim().toLowerCase() : "";
  if (!displayName) {
    return NextResponse.json({ ok: false, message: "请输入日历账户名称" }, { status: 400 });
  }
  if (!/^#[0-9a-f]{6}$/.test(color)) {
    return NextResponse.json({ ok: false, message: "请选择有效的日历颜色" }, { status: 400 });
  }
  const account = await updateCalendarAccountSettings(accountId, { displayName, color });
  if (!account) {
    return NextResponse.json({ ok: false, message: "日历账户不存在" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, account });
}

export async function DELETE(_request: Request, context: CalendarAccountRouteContext) {
  const { accountId } = await context.params;
  if (!await getCalendarAccount(accountId)) {
    return NextResponse.json({ ok: false, message: "日历账户不存在" }, { status: 404 });
  }
  await deleteCalendarAccount(accountId);
  return NextResponse.json({ ok: true });
}
