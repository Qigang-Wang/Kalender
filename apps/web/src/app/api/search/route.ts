import { NextResponse } from "next/server";

import { searchWorkspace, type WorkspaceSearchKind } from "@/server/workspace-search";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("query") ?? "";
    const url = new URL(request.url);
    if (query.trim().length > 100) return NextResponse.json({ ok: false, message: "搜索内容不能超过 100 个字符" }, { status: 400 });
    return NextResponse.json({
      ok: true,
      results: await searchWorkspace(query, {
        kind: searchKind(url.searchParams.get("kind")),
        from: safeText(url.searchParams.get("from")),
        to: safeText(url.searchParams.get("to")),
        projectId: safeText(url.searchParams.get("projectId")),
        accountId: safeText(url.searchParams.get("accountId")),
        status: safeText(url.searchParams.get("status")),
        hasAttachments: url.searchParams.has("hasAttachments") ? url.searchParams.get("hasAttachments") === "true" : undefined,
        limit: Number(url.searchParams.get("limit") ?? 8),
      }),
    });
  } catch (error) {
    console.error("Workspace search failed", error);
    return NextResponse.json({ ok: false, message: "搜索暂时不可用" }, { status: 500 });
  }
}

function searchKind(value: string | null): WorkspaceSearchKind | undefined {
  return value === "mail" || value === "task" || value === "calendar" || value === "note" || value === "project" || value === "ai"
    ? value
    : undefined;
}

function safeText(value: string | null): string | undefined {
  return value && value.length <= 120 ? value : undefined;
}
