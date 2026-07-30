"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { invalidateWorkspaceFetch } from "@/lib/workspace-fetch-cache";

export type RealtimeTopic =
  | "system"
  | "mail"
  | "calendar"
  | "task"
  | "project"
  | "note"
  | "relation"
  | "job"
  | "backup"
  | "settings";

export interface RealtimeEvent {
  readonly topic: RealtimeTopic;
  readonly action: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly userId?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly progress?: number;
  readonly occurredAt: string;
}

export type RealtimeConnectionStatus = "connecting" | "connected" | "disconnected" | "offline";

type RealtimeListener = (event: RealtimeEvent) => void;

interface RealtimeContextValue {
  readonly status: RealtimeConnectionStatus;
  readonly connectedAt?: string;
  readonly lastEvent?: RealtimeEvent;
  readonly reconnectCount: number;
  readonly reconnect: () => void;
  readonly subscribe: (listener: RealtimeListener) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue>({
  status: "disconnected",
  reconnectCount: 0,
  reconnect: () => undefined,
  subscribe: () => () => undefined,
});

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function RealtimeProvider({ children }: { readonly children: ReactNode }) {
  const listenersRef = useRef(new Set<RealtimeListener>());
  const [status, setStatus] = useState<RealtimeConnectionStatus>("connecting");
  const [connectedAt, setConnectedAt] = useState<string>();
  const [lastEvent, setLastEvent] = useState<RealtimeEvent>();
  const [reconnectCount, setReconnectCount] = useState(0);
  const [connectionGeneration, setConnectionGeneration] = useState(0);

  const subscribe = useCallback((listener: RealtimeListener) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;

    const emit = (event: RealtimeEvent) => {
      invalidateWorkspaceFetch();
      setLastEvent(event);
      for (const listener of listenersRef.current) listener(event);
    };

    const scheduleReconnect = () => {
      if (!active || reconnectTimer !== undefined || !navigator.onLine) {
        if (!navigator.onLine) setStatus("offline");
        return;
      }
      setStatus("disconnected");
      const baseDelay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * (2 ** reconnectAttempt));
      const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
      reconnectAttempt += 1;
      setReconnectCount((current) => current + 1);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = () => {
      if (!active || !navigator.onLine) {
        setStatus("offline");
        return;
      }
      setStatus("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/realtime`);
      socket.addEventListener("open", () => {
        if (!active) return;
        reconnectAttempt = 0;
        setConnectedAt(new Date().toISOString());
        setStatus("connected");
      });
      socket.addEventListener("message", (message) => {
        const event = parseRealtimeMessage(message.data);
        if (event) emit(event);
      });
      socket.addEventListener("close", scheduleReconnect);
      socket.addEventListener("error", () => {
        socket?.close();
      });
    };

    const handleOnline = () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      reconnectAttempt = 0;
      connect();
    };
    const handleOffline = () => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      setStatus("offline");
      socket?.close();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    connect();

    return () => {
      active = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      socket?.close(1000, "Page closed");
    };
  }, [connectionGeneration]);

  const reconnect = useCallback(() => {
    setStatus("connecting");
    setConnectionGeneration((current) => current + 1);
  }, []);
  const value = useMemo<RealtimeContextValue>(() => ({
    status,
    connectedAt,
    lastEvent,
    reconnectCount,
    reconnect,
    subscribe,
  }), [connectedAt, lastEvent, reconnect, reconnectCount, status, subscribe]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeStatus(): RealtimeConnectionStatus {
  return useContext(RealtimeContext).status;
}

export function useRealtimeConnection(): Omit<RealtimeContextValue, "subscribe"> {
  const { subscribe: _subscribe, ...connection } = useContext(RealtimeContext);
  return connection;
}

export function useRealtimeEvent(
  topics: readonly RealtimeTopic[],
  listener: (event: RealtimeEvent) => void,
): void {
  const { subscribe } = useContext(RealtimeContext);
  const listenerRef = useRef(listener);
  const topicsKey = topics.join("|");
  listenerRef.current = listener;

  useEffect(() => {
    const acceptedTopics = new Set<RealtimeTopic>(topicsKey.split("|").filter(Boolean) as RealtimeTopic[]);
    return subscribe((event) => {
      if (acceptedTopics.has(event.topic)) listenerRef.current(event);
    });
  }, [subscribe, topicsKey]);
}

export function useRealtimeRefresh(
  topics: readonly RealtimeTopic[],
  refresh: () => void | Promise<void>,
  debounceMs = 150,
): void {
  const { subscribe } = useContext(RealtimeContext);
  const refreshRef = useRef(refresh);
  const timerRef = useRef<number | undefined>(undefined);
  const topicsKey = topics.join("|");
  refreshRef.current = refresh;

  useEffect(() => {
    const acceptedTopics = new Set<RealtimeTopic>(topicsKey.split("|").filter(Boolean) as RealtimeTopic[]);
    const unsubscribe = subscribe((event) => {
      if (event.topic !== "system" && !acceptedTopics.has(event.topic)) return;
      if (event.topic === "system" && event.action !== "connected") return;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        void Promise.resolve(refreshRef.current()).catch(() => undefined);
      }, debounceMs);
    });
    return () => {
      unsubscribe();
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, [debounceMs, subscribe, topicsKey]);
}

function parseRealtimeMessage(value: unknown): RealtimeEvent | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const message = JSON.parse(value) as { readonly type?: unknown; readonly event?: unknown };
    if (message.type !== "event" || !isRealtimeEvent(message.event)) return undefined;
    return message.event;
  } catch {
    return undefined;
  }
}

function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RealtimeEvent>;
  return typeof event.topic === "string"
    && typeof event.action === "string"
    && typeof event.occurredAt === "string";
}
