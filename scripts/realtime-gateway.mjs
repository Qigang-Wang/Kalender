import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import pg from "pg";
import { WebSocket, WebSocketServer } from "ws";

const REALTIME_PATH = "/api/realtime";
const REALTIME_CHANNEL = "kalender_realtime";
const AUTH_COOKIE_NAME = "qgw_session";
const HEARTBEAT_INTERVAL_MS = 30_000;
const LISTENER_RECONNECT_MS = 2_000;
const BROADCAST_COALESCE_MS = 80;

loadLocalEnvFile();

const development = process.argv.includes("--dev");
const gatewayPort = positiveInteger(process.env.PORT, 3000);
const internalPort = positiveInteger(process.env.KALENDER_INTERNAL_PORT, gatewayPort + 1);
const gatewayHost = process.env.HOSTNAME || "0.0.0.0";
const internalHost = "127.0.0.1";
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required by the realtime gateway");
}

const nextProcess = startNextProcess();
const authPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const webSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
});

let shuttingDown = false;
let listener;
let listenerReconnectTimer;
let broadcastTimer;
const pendingBroadcasts = new Map();

const server = createServer((incoming, outgoing) => {
  const upstream = httpRequest({
    hostname: internalHost,
    port: internalPort,
    method: incoming.method,
    path: incoming.url,
    headers: {
      ...incoming.headers,
      "x-forwarded-host": incoming.headers.host ?? "",
      "x-forwarded-proto": forwardedProtocol(incoming),
    },
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
    response.pipe(outgoing);
  });
  upstream.on("error", () => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Retry-After": "1" });
    }
    outgoing.end(JSON.stringify({ ok: false, message: "应用正在启动，请稍后重试" }));
  });
  incoming.pipe(upstream);
});

server.on("upgrade", (request, socket, head) => {
  const pathname = safePathname(request.url);
  if (pathname !== REALTIME_PATH) {
    proxyUpgrade(request, socket, head);
    return;
  }

  if (!sameOriginRequest(request)) {
    rejectUpgrade(socket, 403, "Forbidden");
    return;
  }

  const token = parseCookies(request.headers.cookie)[AUTH_COOKIE_NAME];
  const session = verifySessionToken(token);
  if (!session || session.mustChangePassword) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }

  const timeout = setTimeout(() => rejectUpgrade(socket, 503, "Authentication timeout"), 5_000);
  void authenticateSession(session)
    .then((authenticated) => {
      clearTimeout(timeout);
      if (!authenticated || socket.destroyed) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (client) => {
        client.kalenderSession = authenticated;
        webSocketServer.emit("connection", client, request);
      });
    })
    .catch(() => {
      clearTimeout(timeout);
      rejectUpgrade(socket, 503, "Authentication unavailable");
    });
});

webSocketServer.on("connection", (client) => {
  client.isAlive = true;
  client.on("pong", () => {
    client.isAlive = true;
  });
  client.on("message", (data, isBinary) => {
    if (isBinary || data.length > 1_024) {
      client.close(1003, "Unsupported message");
      return;
    }
    if (data.toString() === "ping") client.send("pong");
  });
  sendEvent(client, {
    topic: "system",
    action: "connected",
    occurredAt: new Date().toISOString(),
  });
});

const heartbeatTimer = setInterval(() => {
  for (const client of webSocketServer.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref();

server.listen(gatewayPort, gatewayHost, () => {
  console.log(`Realtime gateway listening on http://${gatewayHost}:${gatewayPort}`);
});
void connectDatabaseListener();

nextProcess.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(`Next.js process exited (${signal ?? code ?? "unknown"})`);
  void shutdown(code ?? 1);
});

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));

async function connectDatabaseListener() {
  if (shuttingDown) return;
  try {
    const client = new pg.Client({ connectionString: databaseUrl });
    listener = client;
    client.on("notification", (notification) => {
      if (notification.channel !== REALTIME_CHANNEL || !notification.payload) return;
      const event = parseRealtimeEvent(notification.payload);
      if (event) enqueueRealtimeEvent(event);
    });
    client.on("error", () => scheduleListenerReconnect(client));
    client.on("end", () => scheduleListenerReconnect(client));
    await client.connect();
    await client.query(`LISTEN ${REALTIME_CHANNEL}`);
    console.log("Realtime database listener connected");
  } catch (error) {
    console.error("Realtime database listener failed", error instanceof Error ? error.message : error);
    scheduleListenerReconnect(listener);
  }
}

function scheduleListenerReconnect(client) {
  if (client && listener === client) listener = undefined;
  void client?.end().catch(() => undefined);
  if (shuttingDown || listenerReconnectTimer) return;
  listenerReconnectTimer = setTimeout(() => {
    listenerReconnectTimer = undefined;
    void connectDatabaseListener();
  }, LISTENER_RECONNECT_MS);
  listenerReconnectTimer.unref();
}

function broadcastEvent(event) {
  for (const client of webSocketServer.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const session = client.kalenderSession;
    if (event.userId && session?.userId !== event.userId && session?.role !== "admin") continue;
    sendEvent(client, event);
  }
}

function enqueueRealtimeEvent(event) {
  if (event.topic === "job") {
    broadcastEvent(event);
    return;
  }
  const entityKey = event.topic === "task" && event.entityId
    ? `:${event.entityType ?? "entity"}:${event.entityId}`
    : "";
  const key = `${event.userId ?? "*"}:${event.topic}${entityKey}`;
  pendingBroadcasts.set(key, event);
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    const events = [...pendingBroadcasts.values()];
    pendingBroadcasts.clear();
    for (const pending of events) broadcastEvent(pending);
  }, BROADCAST_COALESCE_MS);
  broadcastTimer.unref();
}

function sendEvent(client, event) {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(JSON.stringify({ type: "event", event }));
}

function parseRealtimeEvent(payload) {
  try {
    const candidate = JSON.parse(payload);
    if (!candidate || typeof candidate !== "object" || typeof candidate.topic !== "string") return undefined;
    return {
      topic: candidate.topic.slice(0, 40),
      action: typeof candidate.action === "string" ? candidate.action.slice(0, 40) : "changed",
      entityType: typeof candidate.entityType === "string" ? candidate.entityType.slice(0, 80) : undefined,
      entityId: typeof candidate.entityId === "string" ? candidate.entityId.slice(0, 200) : undefined,
      userId: typeof candidate.userId === "string" ? candidate.userId.slice(0, 200) : undefined,
      kind: typeof candidate.kind === "string" ? candidate.kind.slice(0, 80) : undefined,
      status: typeof candidate.status === "string" ? candidate.status.slice(0, 40) : undefined,
      progress: typeof candidate.progress === "number" ? candidate.progress : undefined,
      occurredAt: new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function authenticateSession(session) {
  const result = await authPool.query(
    `SELECT id, role, session_version, must_change_password
       FROM app_users
      WHERE id = $1 AND disabled_at IS NULL
      LIMIT 1`,
    [session.userId],
  );
  const user = result.rows[0];
  if (!user || Number(user.session_version) !== session.sessionVersion || user.must_change_password) return undefined;
  return {
    userId: user.id,
    role: user.role,
    sessionVersion: Number(user.session_version),
  };
}

function verifySessionToken(token) {
  if (!token) return undefined;
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return undefined;
  const expected = createHmac("sha256", sessionSecret()).update(encodedPayload).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (
      typeof payload.userId !== "string"
      || typeof payload.sessionVersion !== "number"
      || typeof payload.exp !== "number"
      || payload.exp <= Math.floor(Date.now() / 1_000)
    ) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function sessionSecret() {
  return process.env.QGW_AUTH_SECRET
    ?? process.env.AUTH_SECRET
    ?? process.env.NEXTAUTH_SECRET
    ?? process.env.DATABASE_URL
    ?? "qgw-development-auth-secret";
}

function startNextProcess() {
  if (development) {
    return spawn(
      process.execPath,
      [path.resolve("node_modules/next/dist/bin/next"), "dev", "-p", String(internalPort)],
      {
        cwd: path.resolve("apps/web"),
        env: { ...process.env, PORT: String(internalPort), HOSTNAME: internalHost },
        stdio: "inherit",
      },
    );
  }
  return spawn(process.execPath, ["apps/web/server.js"], {
    env: { ...process.env, PORT: String(internalPort), HOSTNAME: internalHost },
    stdio: "inherit",
  });
}

function proxyUpgrade(request, socket, head) {
  const upstream = net.connect(internalPort, internalHost, () => {
    const requestLine = `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n`;
    const headers = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    }
    upstream.write(`${requestLine}${headers.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

function sameOriginRequest(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function forwardedProtocol(request) {
  const forwarded = request.headers["x-forwarded-proto"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return request.socket.encrypted ? "https" : "http";
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n`
    + "Connection: close\r\n"
    + "Content-Type: text/plain; charset=utf-8\r\n"
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    + body,
  );
}

function safePathname(value) {
  try {
    return new URL(value ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loadLocalEnvFile() {
  let content;
  try {
    content = readFileSync(path.resolve(".env"), "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeatTimer);
  if (listenerReconnectTimer) clearTimeout(listenerReconnectTimer);
  if (broadcastTimer) clearTimeout(broadcastTimer);
  for (const client of webSocketServer.clients) client.close(1001, "Server shutting down");
  webSocketServer.close();
  server.close();
  nextProcess.kill("SIGTERM");
  await Promise.allSettled([
    listener?.end(),
    authPool.end(),
  ]);
  process.exit(exitCode);
}
