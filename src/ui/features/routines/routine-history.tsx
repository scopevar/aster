import { IconButton } from "../../components/icon-button.js";
import { Button } from "@heroui/react";
import { Icon } from "../../components/icons.js";
import type { RoutineEditorViewModel } from "./use-routine-editor.js";
const statuses = {
  queued: "排队中",
  running: "运行中",
  cancelling: "取消中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  unknown: "结果未知",
  skipped: "已跳过",
};
export function RoutineHistory({
  view,
  before,
  setBefore,
  reload,
  onConversation,
  disabled,
  submit,
}: Pick<
  RoutineEditorViewModel,
  | "view"
  | "before"
  | "setBefore"
  | "reload"
  | "onConversation"
  | "disabled"
  | "submit"
>) {
  return (
    <section aria-label="运行历史" className="routine-history">
      <div className="routine-history-toolbar">
        <span>运行记录</span>
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="刷新记录"
          onPress={() => reload.current()}
        >
          <Icon name="refresh" size={16} />
        </IconButton>
      </div>
      {view?.events.map((event) => (
        <article key={event.id} className="routine-event">
          <strong>{statuses[event.status]}</strong> ·{" "}
          {event.source === "manual"
            ? "手动测试"
            : event.source === "schedule"
              ? "定时触发"
              : "Webhook"}{" "}
          · {new Date(event.createdAt).toLocaleString()}
          <p>
            定义 v{event.definitionRevision}：{event.name}
          </p>
          {event.scheduledAt !== null && (
            <p>
              计划时间 {new Date(event.scheduledAt).toLocaleString()}
              ；合并至{" "}
              {new Date(event.coveredUntil ?? event.createdAt).toLocaleString()}
            </p>
          )}
          {event.error && <p>{event.error}</p>}
          {event.conversationId && (
            <Button
              variant="secondary"
              onPress={() => onConversation(event.conversationId ?? "")}
            >
              查看会话
            </Button>
          )}
          {event.runId && ["queued", "running"].includes(event.status) && (
            <Button
              variant="secondary"
              isDisabled={disabled}
              onPress={() => {
                if (event.runId)
                  void submit({
                    type: "run.cancel",
                    runId: event.runId,
                  });
              }}
            >
              取消本次运行
            </Button>
          )}
        </article>
      ))}
      {view && !view.events.length && (
        <div className="routine-history-empty">
          <Icon name="clock" size={24} />
          <p>暂无运行记录</p>
        </div>
      )}
      {(before || view?.hasOlder) && (
        <div className="routine-actions routine-history-pagination">
          <Button
            variant="secondary"
            isDisabled={!before}
            onPress={() => setBefore(undefined)}
          >
            最新记录
          </Button>
          <Button
            variant="secondary"
            isDisabled={!view?.hasOlder}
            onPress={() => setBefore(view?.events.at(-1)?.sequence)}
          >
            更早记录
          </Button>
        </div>
      )}
    </section>
  );
}
