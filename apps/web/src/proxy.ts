import { NextRequest, NextResponse } from "next/server";

const AUTH_COOKIE_NAME = "qgw_session";

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const session = await verifySessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value);
  if (session) {
    if (session.mustChangePassword && pathname !== "/change-password" && !pathname.startsWith("/api/users/me") && !pathname.startsWith("/api/auth/logout")) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ ok: false, message: "首次登录需要先修改密码" }, { status: 403 });
      }
      return NextResponse.redirect(new URL("/change-password", request.url));
    }
    if (session.role === "viewer" && pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      return NextResponse.json({ ok: false, message: "只读用户不能修改工作区数据" }, { status: 403 });
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, message: "请先登录" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};

function isPublicPath(pathname: string): boolean {
  return pathname === "/"
    || pathname === "/login"
    || pathname === "/setup"
    || pathname.startsWith("/invite/")
    || pathname === "/api/health"
    || pathname.startsWith("/api/auth/")
    || pathname.startsWith("/_next/")
    || pathname.includes(".");
}

interface ProxySessionPayload {
  readonly role: "admin" | "user" | "viewer";
  readonly mustChangePassword: boolean;
  readonly exp: number;
}

async function verifySessionToken(token: string | undefined): Promise<ProxySessionPayload | undefined> {
  if (!token) return undefined;
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return undefined;
  if (!constantEqual(signature, await signValue(encodedPayload))) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(atobUrl(encodedPayload));
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;
  const candidate = payload as { readonly exp?: unknown; readonly role?: unknown; readonly mustChangePassword?: unknown };
  if (typeof candidate.exp !== "number" || candidate.exp <= Math.floor(Date.now() / 1000)) return undefined;
  if (candidate.role !== "admin" && candidate.role !== "user" && candidate.role !== "viewer") return undefined;
  return {
    role: candidate.role,
    mustChangePassword: candidate.mustChangePassword === true,
    exp: candidate.exp,
  };
}

async function signValue(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

function sessionSecret(): string {
  return process.env.QGW_AUTH_SECRET
    ?? process.env.AUTH_SECRET
    ?? process.env.NEXTAUTH_SECRET
    ?? process.env.DATABASE_URL
    ?? "qgw-development-auth-secret";
}

function atobUrl(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function constantEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
