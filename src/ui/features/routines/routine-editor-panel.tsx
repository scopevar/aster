import { Disclosure } from "../../components/disclosure.js";
import { Button, Input, Tabs, TextArea } from "@heroui/react";
import {
  SettingsSelect,
  SettingsSwitch,
} from "../../components/settings/settings-controls.js";
import "./routines.css";
import { useId, useState } from "react";
import { RoutineHistory } from "./routine-history.js";
import type { RoutineEditorViewModel } from "./use-routine-editor.js";
import { edit, fresh } from "./use-routine-editor.js";
import { Icon } from "../../components/icons.js";
export function RoutineEditorPanel({
  botId,
  draft,
  pending,
  view,
  error,
  readError,
  busy,
  before,
  setBefore,
  onConversation,
  secret,
  setSecret,
  deleteConfirm,
  setDeleteConfirm,
  notice,
  reload,
  current,
  change,
  submit,
  target,
  rotate,
  disabled,
}: Omit<RoutineEditorViewModel, "onClose">) {
  const formId = useId();
  const [tab, setTab] = useState("edit");
  return (
    <div className="routine-manager">
      {(error || readError || view?.schedulerError) && (
        <p role="alert">
          {[error, readError, view?.schedulerError].filter(Boolean).join(" ")}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <Button
          variant="secondary"
          isDisabled={busy}
          onPress={() => {
            void submit(pending.command, pending);
          }}
        >
          重试原操作
        </Button>
      )}
      <div className="routine-columns">
        <nav aria-label="任务列表">
          <Button
            variant="secondary"
            isDisabled={disabled}
            onPress={() => {
              setTab("edit");
              change(fresh());
              setSecret("");
              setBefore(undefined);
            }}
          >
            <Icon name="plus" size={14} />
            新建例行任务
          </Button>
          {view?.routines.map((r) => (
            <Button
              variant={r.id === draft.id ? "tertiary" : "ghost"}
              key={r.id}
              isDisabled={disabled}
              onPress={() => {
                setTab("edit");
                change(edit(r));
                setSecret("");
                setDeleteConfirm(false);
                setBefore(undefined);
              }}
            >
              <strong>{r.name}</strong>
              <span>
                {r.state === "active"
                  ? "已启用"
                  : r.state === "paused"
                    ? "已暂停"
                    : "已删除"}
              </span>
            </Button>
          ))}
          {view && view.routines.length === 0 && (
            <div className="routine-list-empty">
              <Icon name="clock" size={26} />
              <p>暂无例行任务</p>
            </div>
          )}
          {!view && !readError && <p role="status">正在读取…</p>}
        </nav>
        <section className="routine-detail">
          <Tabs
            className="routine-detail-tabs"
            selectedKey={tab}
            onSelectionChange={(key) => {
              if (key === "edit" || key === "history") setTab(key);
            }}
          >
            <Tabs.List aria-label="任务内容">
              <Tabs.Tab id="edit">
                任务设置
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="history">
                运行历史
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel id="edit" className="routine-scroll">
              <form
                id={formId}
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit({
                    type: "routine.save",
                    botId,
                    id: draft.id,
                    revision: draft.revision,
                    name: draft.name,
                    prompt: draft.prompt,
                    ...(draft.revision ? {} : { enabled: draft.enabled }),
                    schedule:
                      draft.kind === "cron"
                        ? {
                            kind: "cron",
                            expression: draft.expression,
                            timeZone: draft.timeZone,
                          }
                        : draft.kind === "at"
                          ? { kind: "at", at: new Date(draft.at).toISOString() }
                          : { kind: "webhook" },
                  });
                }}
              >
                <fieldset disabled={disabled || current?.state === "deleted"}>
                  <label>
                    任务名称
                    <Input
                      variant="secondary"
                      fullWidth
                      aria-label="任务名称"
                      placeholder="例如，每日简报"
                      required
                      maxLength={80}
                      value={draft.name}
                      onChange={(e) =>
                        change({ ...draft, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    执行指令
                    <TextArea
                      variant="secondary"
                      fullWidth
                      aria-label="执行指令"
                      placeholder="希望助手定期为你做什么？"
                      required
                      maxLength={16000}
                      value={draft.prompt}
                      onChange={(e) =>
                        change({ ...draft, prompt: e.target.value })
                      }
                    />
                  </label>
                  <div className="routine-field">
                    <span>触发方式</span>
                    <SettingsSelect
                      label="触发方式"
                      value={draft.kind}
                      disabled={disabled || current?.state === "deleted"}
                      onChange={(value) => {
                        if (
                          value === "at" ||
                          value === "cron" ||
                          value === "webhook"
                        )
                          change({ ...draft, kind: value });
                      }}
                      options={[
                        { value: "cron", label: "定时" },
                        { value: "at", label: "一次" },
                        { value: "webhook", label: "Webhook" },
                      ]}
                    />
                  </div>
                  {draft.kind === "at" && (
                    <label>
                      执行时间
                      <Input
                        variant="secondary"
                        fullWidth
                        aria-label="执行时间"
                        type="datetime-local"
                        required
                        value={draft.at}
                        onChange={(e) =>
                          change({ ...draft, at: e.target.value })
                        }
                      />
                      <small className="muted">按本机时区保存。</small>
                    </label>
                  )}
                  {draft.kind === "cron" && (
                    <>
                      <label>
                        五段 cron
                        <Input
                          variant="secondary"
                          fullWidth
                          aria-label="五段 cron"
                          required
                          value={draft.expression}
                          maxLength={120}
                          onChange={(e) =>
                            change({ ...draft, expression: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        任务时区
                        <Input
                          variant="secondary"
                          fullWidth
                          aria-label="任务时区"
                          required
                          value={draft.timeZone}
                          maxLength={100}
                          onChange={(e) =>
                            change({ ...draft, timeZone: e.target.value })
                          }
                        />
                      </label>
                      <Disclosure
                        className="routine-schedule-help"
                        title={<>调度说明</>}
                      >
                        <p className="muted">
                          0 9 * * 1-5 表示工作日
                          09:00。错过多个时刻合并运行一次；重叠的定时运行会记录为跳过，Webhook
                          会排队等待处理。
                        </p>
                      </Disclosure>
                    </>
                  )}
                </fieldset>
              </form>
              {current && target && (
                <>
                  <p>
                    状态：
                    {current.state === "active"
                      ? "已启用"
                      : current.state === "paused"
                        ? "已暂停"
                        : "已删除"}{" "}
                    · 版本 {current.revision}
                  </p>
                  {current.nextAt !== null && (
                    <p>
                      下次运行：
                      {new Date(current.nextAt).toLocaleString("zh-CN", {
                        timeZone:
                          current.schedule.kind === "cron"
                            ? current.schedule.timeZone
                            : undefined,
                      })}
                    </p>
                  )}
                  {current.state !== "deleted" && (
                    <div className="routine-actions">
                      <Button
                        variant="secondary"
                        isDisabled={disabled}
                        onPress={() => {
                          void submit({
                            type: "routine.state",
                            ...target,
                            state:
                              current.state === "active" ? "paused" : "active",
                          });
                        }}
                      >
                        {current.state === "active" ? "暂停任务" : "启用任务"}
                      </Button>
                      <Button
                        variant="secondary"
                        isDisabled={disabled}
                        onPress={() => {
                          void submit({ type: "routine.test", ...target });
                        }}
                      >
                        测试一次（真实执行）
                      </Button>
                      <Button
                        variant="secondary"
                        isDisabled={disabled}
                        onPress={() => setDeleteConfirm(true)}
                      >
                        删除任务
                      </Button>
                    </div>
                  )}
                  {deleteConfirm && (
                    <div role="group" aria-label="确认删除任务">
                      <p>删除后停止未来触发并取消未完成运行，保留历史。</p>
                      <Button
                        variant="secondary"
                        isDisabled={disabled}
                        onPress={() => {
                          void submit({
                            type: "routine.state",
                            ...target,
                            state: "deleted",
                          });
                        }}
                      >
                        确认删除任务
                      </Button>
                      <Button
                        variant="secondary"
                        onPress={() => setDeleteConfirm(false)}
                      >
                        返回
                      </Button>
                    </div>
                  )}
                  {current.schedule.kind === "webhook" &&
                    current.state !== "deleted" && (
                      <div className="routine-hook">
                        <p>
                          本机地址：
                          <code>
                            {view?.webhookBase}/{current.id}
                          </code>
                        </p>
                        <p>
                          密钥：{current.hasKey ? "已配置" : "未配置"}
                          。生成或轮换后仅显示一次；旧密钥立即失效。
                        </p>
                        <Button
                          variant="secondary"
                          isDisabled={disabled}
                          onPress={() => {
                            void rotate();
                          }}
                        >
                          {current.hasKey ? "轮换密钥" : "生成密钥"}
                        </Button>
                        {current.hasKey && (
                          <Button
                            variant="secondary"
                            isDisabled={disabled}
                            onPress={() => {
                              setSecret("");
                              void submit({
                                type: "routine.key",
                                ...target,
                                hash: null,
                              });
                            }}
                          >
                            撤销密钥
                          </Button>
                        )}
                        {secret && (
                          <label>
                            新密钥
                            <Input
                              variant="secondary"
                              fullWidth
                              aria-label="新密钥"
                              readOnly
                              value={secret}
                            />
                          </label>
                        )}
                        <p>
                          POST 使用 Authorization: Bearer 密钥；JSON 包含
                          eventId、timestamp（当前毫秒时间戳）、text。相同
                          eventId 重试不会重复执行；返回 202 仅表示接收。GET
                          地址追加 /events/返回的记录ID 可查询结果。
                        </p>
                      </div>
                    )}
                </>
              )}
            </Tabs.Panel>
            <Tabs.Panel id="history" className="routine-scroll">
              <RoutineHistory
                {...{
                  view,
                  before,
                  setBefore,
                  reload,
                  onConversation,
                  disabled,
                  submit,
                }}
              />
            </Tabs.Panel>
          </Tabs>
          {tab === "edit" && (
            <footer className="routine-form-actions">
              {!draft.revision && (
                <div className="routine-enable">
                  <span>创建后启用</span>
                  <SettingsSwitch
                    label="创建后启用"
                    selected={draft.enabled}
                    disabled={disabled}
                    onChange={(enabled) => change({ ...draft, enabled })}
                  />
                </div>
              )}
              <Button
                variant="primary"
                type="submit"
                form={formId}
                isDisabled={disabled || current?.state === "deleted"}
              >
                {draft.revision ? "保存任务" : "创建任务"}
              </Button>
            </footer>
          )}
        </section>
      </div>
    </div>
  );
}
