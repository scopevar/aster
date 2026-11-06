import { Checkbox } from "../../components/checkbox.js";
import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { AppError } from "../../../shared/core.js";
import { type Bot } from "../../../shared/chat/bots.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import {
  storedDesktopEnvelopeSchema,
  type DesktopEnvelope,
} from "../../../shared/desktop/desktop-commands.js";
import {
  templatesResponseSchema,
  templateFileResultSchema,
  type LocalTemplates,
  type TemplateDraft,
  type TemplatePayload,
} from "../../../shared/templates/templates.js";
import { desktop, envelope, execute, errorMessage } from "../../lib/client.js";
import { Modal } from "../../components/modal.js";
import { TemplateEditor } from "./template-editor.js";
import { TemplateSelection } from "./template-selection.js";
import { templateEditCacheSchema } from "./template-edit-cache.js";
import "./templates.css";
import { Icon } from "../../components/icons.js";

const pendingKey = "local-template-command";
export function Templates({
  bot,
  initialDraftId,
  onClose,
  onConversation,
}: {
  bot?: Bot;
  initialDraftId?: string;
  onClose(): void;
  onConversation(id: string): void;
}) {
  const [view, setView] = useState<LocalTemplates>({ drafts: [] });
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [preview, setPreview] = useState<TemplatePayload | null>(null);
  const [includeSkills, setIncludeSkills] = useState(false);
  const [includeRoutines, setIncludeRoutines] = useState(false);
  const [includePlugins, setIncludePlugins] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<DesktopEnvelope | null>(null);
  const [damaged, setDamaged] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  const refresh = async () => {
    const response = templatesResponseSchema.parse(
      await desktop.templates({ kind: "local" }),
    );
    if (alive.current && response.kind === "local") setView(response.data);
  };
  const read = async (id: string) => {
    const response = templatesResponseSchema.parse(
      await desktop.templates({ kind: "draft", id }),
    );
    if (alive.current && response.kind === "draft") {
      const raw = localStorage.getItem(`local-template-edit:${id}`);
      if (raw) {
        const cached = templateEditCacheSchema.parse(JSON.parse(raw));
        if (cached.id !== id || cached.revision !== response.data.revision)
          throw new Error(
            "模板已有新版本，旧编辑草稿已保留，请先核实本地草稿。",
          );
        setDraft(cached);
        setDirty(true);
      } else {
        setDraft(response.data);
        setDirty(false);
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh()
      .then(() => (initialDraftId ? read(initialDraftId) : undefined))
      .catch((cause: unknown) => {
        if (alive.current) setError(errorMessage(cause));
      });
    const raw = localStorage.getItem(pendingKey);
    if (raw) {
      try {
        const saved = storedDesktopEnvelopeSchema.parse(JSON.parse(raw));
        if (!saved.command.type.startsWith("template."))
          throw new Error("模板操作类型无效。");
        setPending(saved);
      } catch {
        setDamaged(true);
        setError(
          "上次模板操作记录无法读取，原记录已保留。请先核实本地模板和 Bot 列表。",
        );
      }
    }
    return () => {
      alive.current = false;
    };
  }, [initialDraftId]);
  const run = async (command?: Command) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      if (damaged)
        throw new Error(
          "请先保留损坏记录并核实 Bot 和本地模板，不能覆盖原请求。",
        );
      if (pending && command)
        throw new Error("上次操作结果尚未确认，请先核实原请求。");
      const request = pending ?? (command ? envelope(command) : null);
      if (!request) return;
      localStorage.setItem(pendingKey, JSON.stringify(request));
      setPending(request);
      const result = await execute(request);
      localStorage.removeItem(pendingKey);
      setPending(null);
      if (
        request.command.type === "template.save" ||
        request.command.type === "template.delete"
      )
        localStorage.removeItem(`local-template-edit:${request.command.id}`);
      if (!alive.current) return;
      await refresh();
      if (request.command.type === "template.import" && result.conversationId) {
        setPreview(null);
        onConversation(result.conversationId);
        onClose();
      } else if (request.command.type === "template.delete") {
        setDraft(null);
        setDirty(false);
      } else if (result.id) await read(result.id);
    } catch (cause) {
      if (
        cause instanceof AppError &&
        [
          "invalid_input",
          "conflict",
          "not_found",
          "capacity",
          "unauthorized",
        ].includes(cause.code)
      ) {
        localStorage.removeItem(pendingKey);
        setPending(null);
      }
      if (alive.current) setError(errorMessage(cause));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Modal
      title="本地模板"
      className="templates-dialog"
      wide
      busy={busy}
      onClose={() => {
        if (!busy && (!dirty || window.confirm("关闭后放弃未保存的模板修改？")))
          onClose();
      }}
    >
      <div className="templates-manager">
        <nav>
          <Button
            variant="secondary"
            isDisabled={busy || !!pending || damaged}
            onPress={() => {
              setBusy(true);
              setError("");
              void desktop
                .templateFile({ action: "open" })
                .then((value) => {
                  const result = templateFileResultSchema.parse(value);
                  if (!result.cancelled && alive.current)
                    setPreview(result.payload);
                })
                .catch((cause: unknown) => setError(errorMessage(cause)))
                .finally(() => setBusy(false));
            }}
          >
            <Icon name="file" size={15} />
            导入模板文件
          </Button>
        </nav>
        {error && <p role="alert">{error}</p>}
        {damaged && (
          <Button
            isDisabled={busy}
            onPress={() => {
              try {
                const raw = localStorage.getItem(pendingKey);
                if (raw !== null)
                  localStorage.setItem(
                    `${pendingKey}:unreadable:${crypto.randomUUID()}`,
                    raw,
                  );
                if (localStorage.getItem(pendingKey) !== raw)
                  throw new Error("请求记录已变化，请重新读取。");
                localStorage.removeItem(pendingKey);
                setDamaged(false);
                setError("");
              } catch (cause) {
                setError(errorMessage(cause));
              }
            }}
          >
            已核实结果，保留损坏记录并重新编辑
          </Button>
        )}
        {pending && (
          <Button isDisabled={busy} onPress={() => void run()}>
            核实上次模板操作
          </Button>
        )}
        {bot && (
          <fieldset
            disabled={busy || !!pending || damaged}
            className="template-editor template-create"
          >
            <legend>从 {bot.name} 创建模板</legend>
            <div className="template-create-options">
              <Checkbox
                isSelected={includeSkills}
                onChange={(selected) => setIncludeSkills(selected)}
                isDisabled={busy || !!pending || damaged}
              >
                包含技能
              </Checkbox>
              <Checkbox
                isSelected={includeRoutines}
                onChange={(selected) => setIncludeRoutines(selected)}
                isDisabled={busy || !!pending || damaged}
              >
                包含任务
              </Checkbox>
              <Checkbox
                isSelected={includePlugins}
                onChange={(selected) => setIncludePlugins(selected)}
                isDisabled={busy || !!pending || damaged}
              >
                包含插件依赖声明
              </Checkbox>
            </div>
            <Button
              variant="primary"
              isDisabled={busy || !!pending || damaged}
              onPress={() =>
                void run({
                  type: "template.create",
                  botId: bot.id,
                  includeSkills,
                  includeRoutines,
                  includePlugins,
                })
              }
            >
              创建本地模板
            </Button>
          </fieldset>
        )}
        {preview && (
          <section className="template-preview" aria-label="模板导入预览">
            <h3>{preview.name}</h3>
            <p>{preview.description}</p>
            <p>
              {preview.skills.length} 个技能 · {preview.routines.length} 个任务
            </p>
            {preview.plugins.map((plugin, index) => (
              <p key={index}>
                需自行安装：{plugin.name} {plugin.version}
              </p>
            ))}
            <p>
              导入将创建新
              Bot；使用你自己的模型配置，任务全部暂停，不安装或启用插件。
            </p>
            <Button
              variant="primary"
              isDisabled={busy || !!pending || damaged}
              onPress={() =>
                void run({ type: "template.import", payload: preview })
              }
            >
              确认导入为新 Bot
            </Button>
            <Button isDisabled={busy} onPress={() => setPreview(null)}>
              取消导入
            </Button>
          </section>
        )}
        <div className="template-workspace">
          <nav aria-label="本地模板列表">
            {view.drafts.map((item) => (
              <Button
                key={item.id}
                variant={draft?.id === item.id ? "tertiary" : "ghost"}
                className="template-draft-item"
                isDisabled={busy || !!pending || damaged || dirty}
                onPress={() =>
                  void read(item.id).catch((cause: unknown) =>
                    setError(errorMessage(cause)),
                  )
                }
              >
                <Icon name="book" size={15} />
                <span>{item.name}</span>
              </Button>
            ))}
          </nav>
          {!draft && view.drafts.length > 0 && !preview && (
            <div className="template-library-empty">
              <Icon name="book" size={32} />
              <h3>选择一个模板</h3>
              <p>从列表中选择，查看并编辑模板内容。</p>
            </div>
          )}
          {draft && (
            <div>
              <TemplateEditor
                value={draft.payload}
                disabled={busy || !!pending || damaged}
                onChange={(payload) => {
                  const next = { ...draft, payload };
                  setDraft(next);
                  setDirty(true);
                  try {
                    localStorage.setItem(
                      `local-template-edit:${draft.id}`,
                      JSON.stringify(next),
                    );
                  } catch {
                    setError(
                      "编辑草稿未能保存到本地存储，请保留窗口并保存模板。",
                    );
                  }
                }}
              />
              <div className="template-actions">
                <Button
                  variant="primary"
                  isDisabled={busy || !!pending || damaged || !dirty}
                  onPress={() =>
                    void run({
                      type: "template.save",
                      id: draft.id,
                      revision: draft.revision,
                      payload: draft.payload,
                    })
                  }
                >
                  保存模板
                </Button>
                <Button
                  isDisabled={busy || !!pending || damaged}
                  onPress={() => {
                    if (
                      window.confirm("删除这个本地模板？Bot 和聊天不受影响。")
                    )
                      void run({
                        type: "template.delete",
                        id: draft.id,
                        revision: draft.revision,
                      });
                  }}
                >
                  删除模板
                </Button>
              </div>
              <TemplateSelection
                key={`${draft.id}:${draft.revision}`}
                draft={draft}
                disabled={busy || !!pending || damaged || dirty}
              />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
