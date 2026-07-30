"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface ClientSyncSettings {
  readonly mailSyncEnabled: boolean;
  readonly mailSyncIntervalMs: number;
  readonly calendarSyncEnabled: boolean;
  readonly calendarSyncIntervalMs: number;
  readonly clientRefreshEnabled: boolean;
  readonly clientRefreshIntervalMs: number;
  readonly updatedAt?: string;
}

interface SyncSettingsContextValue {
  readonly settings: ClientSyncSettings;
  readonly loading: boolean;
  readonly canEdit: boolean;
  readonly error?: string;
  readonly save: (settings: ClientSyncSettings) => Promise<ClientSyncSettings>;
  readonly reload: () => Promise<void>;
}

const DEFAULT_SETTINGS: ClientSyncSettings = {
  mailSyncEnabled: true,
  mailSyncIntervalMs: 3 * 60_000,
  calendarSyncEnabled: true,
  calendarSyncIntervalMs: 3 * 60_000,
  clientRefreshEnabled: true,
  clientRefreshIntervalMs: 15_000,
};

const SyncSettingsContext = createContext<SyncSettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  loading: true,
  canEdit: false,
  save: async () => DEFAULT_SETTINGS,
  reload: async () => undefined,
});

export function SyncSettingsProvider({ children }: { readonly children: ReactNode }) {
  const [settings, setSettings] = useState<ClientSyncSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/sync-settings", { cache: "no-store" });
      const payload = await response.json() as {
        readonly ok?: boolean;
        readonly settings?: ClientSyncSettings;
        readonly canEdit?: boolean;
        readonly message?: string;
      };
      if (!response.ok || !payload.ok || !payload.settings) {
        throw new Error(payload.message || "无法读取同步设置");
      }
      setSettings(payload.settings);
      setCanEdit(payload.canEdit === true);
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取同步设置");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const save = useCallback(async (nextSettings: ClientSyncSettings) => {
    const response = await fetch("/api/sync-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextSettings),
    });
    const payload = await response.json() as {
      readonly ok?: boolean;
      readonly settings?: ClientSyncSettings;
      readonly canEdit?: boolean;
      readonly message?: string;
    };
    if (!response.ok || !payload.ok || !payload.settings) {
      throw new Error(payload.message || "无法保存同步设置");
    }
    setSettings(payload.settings);
    setCanEdit(payload.canEdit === true);
    setError(undefined);
    return payload.settings;
  }, []);

  const value = useMemo<SyncSettingsContextValue>(() => ({
    settings,
    loading,
    canEdit,
    error,
    save,
    reload,
  }), [canEdit, error, loading, reload, save, settings]);

  return <SyncSettingsContext.Provider value={value}>{children}</SyncSettingsContext.Provider>;
}

export function useSyncSettings() {
  return useContext(SyncSettingsContext);
}
