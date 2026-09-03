import { NextResponse } from "next/server";

import { AuthError, getCurrentAppUser } from "@/server/auth";
import { McpTokenError, createMcpToken, listMcpTokens, mcpTokenScopes, type McpTokenScope } from "@/server/mcp-token-repository";

export const runtime = "nodejs";

interface CreateMcpTokenBody {
  readonly name?: unknown;
  readonly scopes?: unknown;
  readonly expiresAt?: unknown;
}

export async function GET() {
  try {
    const actor = await requireActor();
    return NextResponse.json({ ok: true, tokens: await listMcpTokens(actor) });
  } catch (error) {
    return mcpTokenErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor();
    const body = await request.json().catch(() => null) as CreateMcpTokenBody | null;
    const created = await createMcpToken(actor, {
      name: nameValue(body?.name),
      scopes: scopeValues(body?.scopes),
      expiresAt: expiryValue(body?.expiresAt),
    });
    const { secret, ...token } = created;
    return NextResponse.json({ ok: true, token, secret }, { status: 201 });
  } catch (error) {
    return mcpTokenErrorResponse(error);
  }
}

async function requireActor() {
  const actor = await getCurrentAppUser();
  if (!actor) throw new AuthError("请先登录", 401);
  return actor;
}

function scopeValues(value: unknown): readonly McpTokenScope[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string" || !mcpTokenScopes.includes(scope as McpTokenScope))) {
    throw new McpTokenError("MCP API 令牌权限无效", 400);
  }
  return value as McpTokenScope[];
}

function nameValue(value: unknown): string {
  if (typeof value !== "string") throw new McpTokenError("MCP API 令牌名称不能为空", 400);
  return value;
}

function expiryValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new McpTokenError("MCP API 令牌过期时间无效", 400);
  return value;
}

function mcpTokenErrorResponse(error: unknown) {
  const normalized = error instanceof AuthError || error instanceof McpTokenError
    ? error
    : new McpTokenError("MCP API 令牌操作失败", 500);
  return NextResponse.json({ ok: false, message: normalized.message }, { status: normalized.status });
}
