import { Disclosure } from "../../components/disclosure.js";
import { Button } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import {
  routineViewSchema,
  type RoutineView,
} from "../../../shared/routines.js";
import { desktop, errorMessage } from "../../lib/client.js";
import { Icon } from "../../components/icons.js";
import "./routine-overview.css";

export function RoutineOverview({
  botId,
  suspended,
  onOpen,
}: {
  botId: string;
  suspended: boolean;
  onOpen(id?: string): void | Promise<void>;
}) {
  const [view, setView] = useState<RoutineView | null>(null);
  const [error, setError] = useState("");
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    if (suspended) return;
    let disposed = false;
    let inflight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer);
      if (disposed || inflight || document.hidden) return;
      inflight = true;
      try {
        const next = routineViewSchema.parse(await desktop.routines({ botId }));
        if (!disposed) {
          setView(next);
          setError("");
        }
      } catch (reason) {
        if (!disposed) setError(errorMessage(reason));
      } finally {
        inflight = false;
        if (!disposed && !document.hidden)
          timer = setTimeout(() => void load(), 2000);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void load();
    };
    reload.current = () => void load();
    document.addEventListener("visibilitychange", visibility);
    void load();
    return () => {
      disposed = true;
      reload.current = () => {};
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [botId, suspended]);
  const routines = view?.routines.filter(
    (routine) => routine.state !== "deleted",
  );
  return (
    <section className="routine-overview" aria-label="例行任务概览">
      {error && (
        <div className="routine-overview-error" role="alert">
          <p>
            {view ? "任务列表可能已过期。" : "无法读取例行任务。"}
            请重新读取，后台恢复后也会自动重试。
          </p>
          <Disclosure title={<>错误详情</>}>
            <p>{error}</p>
          </Disclosure>
          <Button
            variant="secondary"
            className="secondary"
            onPress={() => reload.current()}
          >
            重新读取任务
          </Button>
        </div>
      )}
      {view?.schedulerError && <p role="alert">{view.schedulerError}</p>}
      {!view && !error && (
        <p className="routine-overview-empty" role="status">
          正在读取例行任务…
        </p>
      )}
      {routines?.length === 0 && !error && (
        <p className="routine-overview-empty">
          例行任务是这个 Bot 按时间表定期运行的任务。请在聊天中让它创建一个。
        </p>
      )}
      {!!routines?.length && (
        <ul className="routine-overview-list" aria-label="例行任务">
          {routines.map((routine) => (
            <li key={routine.id}>
              <Button variant="ghost" onPress={() => void onOpen(routine.id)}>
                <Icon
                  name={routine.schedule.kind === "webhook" ? "link" : "clock"}
                  size={18}
                />
                <span>
                  <strong>{routine.name}</strong>
                  <small>
                    {routine.state === "paused" ? "已暂停 · " : ""}
                    {routine.schedule.kind === "webhook"
                      ? "Webhook"
                      : routine.schedule.kind === "at"
                        ? `一次性 · ${new Date(routine.schedule.at).toLocaleString("zh-CN")}`
                        : routine.schedule.kind === "delay"
                          ? `延迟 ${routine.schedule.seconds} 秒`
                          : `${routine.schedule.expression} · ${routine.schedule.timeZone}`}
                  </small>
                  {routine.error && (
                    <small className="routine-overview-warning">
                      {routine.error}
                    </small>
                  )}
                </span>
                <Icon name="chevron" size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="ghost"
        className="routine-overview-manage"
        onPress={() => void onOpen()}
      >
        管理例行任务
      </Button>
    </section>
  );
}
