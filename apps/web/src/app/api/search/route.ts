import { NextResponse } from "next/server";

import { searchWorkspace } from "@/server/workspace-search";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("query") ?? "";
    if (query.trim().length > 100) return NextResponse.json({ ok: false, message: "搜索内容不能超过 100 个字符" }, { status: 400 });
    return NextResponse.json({ ok: true, results: await searchWorkspace(query) });
  } catch (error) {
    console.error("Workspace search failed", error);
    return NextResponse.json({ ok: false, message: "搜索暂时不可用" }, { status: 500 });
  }
}
