import {
  createContext,
  useEffect,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { AgentConnectionsStatus } from "../../../shared/agent-connections.js";
import type { AppUpdateState } from "../../../shared/desktop/app-update.js";
import { subscribeAppUpdate } from "../../lib/client.js";

type SettingsData = {
  connections: AgentConnectionsStatus | null;
  updates: AppUpdateState | null;
};
const empty: SettingsData = {
  connections: null,
  updates: null,
};
const Context = createContext<{
  data: SettingsData;
  update<K extends keyof SettingsData>(
    key: K,
    value: SetStateAction<SettingsData[K]>,
  ): void;
  load<K extends keyof SettingsData>(
    key: K,
    read: () => Promise<SettingsData[K]>,
  ): Promise<void>;
  busy: Set<string>;
  run(key: string, work: () => Promise<void>): Promise<void>;
} | null>(null);

// Cache only for the lifetime of the open settings page, never across accounts.
export function SettingsDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState(empty);
  const pending = useRef(new Map<keyof SettingsData, Promise<void>>());
  const mutations = useRef(new Map<string, Promise<void>>());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const run = useCallback((key: string, work: () => Promise<void>) => {
    const current = mutations.current.get(key);
    if (current) return current;
    // Autosave reports its own error; the next explicit action still runs afterward.
    const rename = mutations.current.get("rename");
    const ready =
      rename && key !== "rename" ? rename.catch(() => {}) : Promise.resolve();
    const request = ready.then(work).finally(() => {
      mutations.current.delete(key);
      setBusy(new Set(mutations.current.keys()));
    });
    mutations.current.set(key, request);
    setBusy(new Set(mutations.current.keys()));
    return request;
  }, []);
  const update = useCallback(
    <K extends keyof SettingsData>(
      key: K,
      value: SetStateAction<SettingsData[K]>,
    ) => {
      setData((current) => ({
        ...current,
        [key]: typeof value === "function" ? value(current[key]) : value,
      }));
    },
    [],
  );
  const load = useCallback(
    <K extends keyof SettingsData>(
      key: K,
      read: () => Promise<SettingsData[K]>,
    ) => {
      const current = pending.current.get(key);
      if (current) return current;
      const rename = mutations.current.get("rename");
      const ready = rename ? rename.catch(() => {}) : Promise.resolve();
      const request = ready
        .then(read)
        .then((value) => {
          update(key, value);
        })
        .finally(() => {
          if (pending.current.get(key) === request) pending.current.delete(key);
        });
      pending.current.set(key, request);
      return request;
    },
    [update],
  );
  useEffect(
    () => subscribeAppUpdate((next) => update("updates", next)),
    [update],
  );
  return (
    <Context value={{ data, update, load, busy, run }}>{children}</Context>
  );
}

export function useSettingsMutation() {
  const context = useContext(Context);
  if (!context) throw Error("设置操作需要在设置页面中执行。");
  return { busy: context.busy, run: context.run };
}

export function useSettingsData<K extends keyof SettingsData>(key: K) {
  const context = useContext(Context);
  if (!context) throw Error("设置数据需要在设置页面中读取。");
  const { update, load } = context;
  const set = useCallback(
    (value: SetStateAction<SettingsData[K]>) => {
      update(key, value);
    },
    [key, update],
  );
  const read = useCallback(
    (loader: () => Promise<SettingsData[K]>) => load(key, loader),
    [key, load],
  );
  return [context.data[key], set, read] as const;
}
