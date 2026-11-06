import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../shared/snapshot.js";
import {
  sameCursor,
  type StoreCursor,
  type WorkerSignal,
} from "../../shared/worker-events.js";
import {
  errorMessage,
  snapshotSince,
  subscribeWorker,
  workerStatus,
} from "./client.js";
const safetyPollMs = 30000;
const offlinePollMs = 5000;
// [Perf]: 流式落库每 100ms 推送一次；合并提示，把快照计算限制在每秒 5 次以内。
const minPullGapMs = 200;
const empty: Snapshot = {
  sidebar: { revision: 0, sections: [], unassignedCollapsed: false },
  deletions: [],
  deletedClientKeys: [],
  revision: 0,
  // 尚未连接后台，任何真实 epoch 都与之不同，首次读取必然取到完整快照。
  epoch: "00000000-0000-4000-8000-000000000000",
  bots: [],
  skills: [],
  conversations: [],
  recentEmojis: [],
  messages: [],
  runs: [],
  hasOlder: false,
  capabilities: {
    agent: "unchecked",
    detail: "尚未检查模型连接。",
    accountType: null,
  },
};
export function useWorkerSnapshot(selected: string | null) {
  const [state, setState] = useState(empty);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const current = useRef(selected);
  current.current = selected;

  const synced = useRef<{
    conversationId: string | null;
    cursor: StoreCursor;
  } | null>(null);
  const refreshGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const id = current.current;
    const reusable = synced.current?.conversationId === id;
    const next = await snapshotSince({
      ...(id ? { conversationId: id } : {}),
      ...(reusable && synced.current ? { since: synced.current.cursor } : {}),
    }).catch((cause: unknown) => {
      if (generation !== refreshGeneration.current || current.current !== id)
        return null;
      throw cause;
    });
    // [Lifecycle]: A late reply from an old account must not replace a newer epoch, including navigation away and back to the same conversation.
    if (generation !== refreshGeneration.current || current.current !== id)
      return;
    setConnected(true);
    setConnectionError("");
    if (!next) return;
    synced.current = {
      conversationId: id,
      cursor: { epoch: next.epoch, revision: next.revision },
    };
    setState((previous) =>
      // epoch 不同代表换了数据库（切换账号或恢复备份），revision 不可跨库比较。
      next.epoch !== previous.epoch || next.revision >= previous.revision
        ? next
        : previous,
    );
  }, []);
  useEffect(() => {
    let disposed = false,
      live = false,
      signalSeen = false,
      inFlight = false,
      again = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let lastStart = 0,
      deferred = false;
    const schedule = (delay = live ? safetyPollMs : offlinePollMs) => {
      clearTimeout(timer);
      timer = setTimeout(() => void pull(), delay);
    };
    // [Invariant]: 同一时刻最多一个在途拉取；期间到达的提示只记一笔，结束后补拉一次。
    const pull = async () => {
      if (disposed) return;
      if (inFlight) {
        again = true;
        return;
      }
      const wait = lastStart + minPullGapMs - Date.now();
      if (wait > 0) {
        deferred = true;
        return schedule(wait);
      }
      deferred = false;
      lastStart = Date.now();
      inFlight = true;
      try {
        await refresh();
      } catch (e) {
        if (!disposed) {
          setConnected(false);
          setConnectionError(errorMessage(e));
        }
      } finally {
        inFlight = false;
        if (!disposed) {
          if (again) {
            again = false;
            void pull();
          } else schedule();
        }
      }
    };
    const apply = (signal: WorkerSignal) => {
      if (disposed) return;
      live = signal.state === "live";
      const known = synced.current?.cursor;
      if (signal.state === "live" && known && sameCursor(known, signal.cursor))
        return deferred ? undefined : schedule();
      void pull();
    };
    const unsubscribe = subscribeWorker((signal) => {
      signalSeen = true;
      apply(signal);
    });
    void workerStatus()
      .then((signal) => {
        // 订阅先于状态查询返回时，以更新的推送为准。
        if (!signalSeen) apply(signal);
      })
      .catch(() => {
        if (!signalSeen) void pull();
      });
    return () => {
      disposed = true;
      refreshGeneration.current++;
      unsubscribe();
      clearTimeout(timer);
    };
  }, [refresh]);
  return {
    state,
    setState,
    connected,
    connectionError,
    current,
    synced,
    refresh,
  };
}
