import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { McpTokenError, revokeMcpToken } from "@/server/mcp-token-repository";

export const runtime = "nodejs";

interface McpTokenRouteProps {
  readonly params: Promise<{ readonly tokenId: string }>;
}

export async function DELETE(_request: Request, { params }: McpTokenRouteProps) {
  try {
    const actor = await requireActor();
    const { tokenId } = await params;
    return NextResponse.json({ ok: true, token: await revokeMcpToken(actor, tokenId) });
  } catch (error) {
    return mcpTokenErrorResponse(error);
  }
}

async function requireActor() {
  const actor = await getCurrentAppUser();
  if (!actor) throw new AuthError("请先登录", 401);
  return actor;
}

function mcpTokenErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError || error instanceof McpTokenError
    ? error
    : new McpTokenError("MCP API 令牌操作失败", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
