import { storedDesktopEnvelopeSchema as envelopeSchema } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../../shared/desktop/desktop-commands.js";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AppError, type CommandResult } from "../../../shared/core.js";
import {
  routineViewSchema,
  type Routine,
  type RoutineView,
  type RoutineQuery,
} from "../../../shared/routines.js";
import { desktop, envelope, errorMessage, execute } from "../../lib/client.js";
import { defaultTimeZone } from "../../../shared/desktop/preferences.js";
const localInput = (value: number) => {
  const date = new Date(value),
    pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const draftSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  name: z.string().max(80),
  prompt: z.string().max(16000),
  kind: z.enum(["at", "cron", "webhook"]),
  enabled: z.boolean().default(true),
  at: z.string().max(40).default(""),
  expression: z.string().max(120),
  timeZone: z.string().max(100),
});
const savedSchema = z.object({
  draft: draftSchema,
  pending: envelopeSchema.nullable(),
});
type Draft = z.infer<typeof draftSchema>;
export const fresh = (): Draft => ({
  id: crypto.randomUUID(),
  revision: 0,
  name: "",
  prompt: "",
  kind: "cron",
  enabled: true,
  at: localInput(Date.now() + 3600000),
  expression: "0 9 * * 1-5",
  timeZone: defaultTimeZone,
});
export const edit = (r: Routine): Draft => ({
  id: r.id,
  revision: r.revision,
  name: r.name,
  prompt: r.prompt,
  kind: r.schedule.kind === "delay" ? "at" : r.schedule.kind,
  enabled: r.state === "active",
  at:
    r.schedule.kind === "at"
      ? localInput(Date.parse(r.schedule.at))
      : r.schedule.kind === "delay"
        ? localInput(Date.now() + r.schedule.seconds * 1000)
        : localInput(Date.now() + 3600000),
  expression:
    r.schedule.kind === "cron" ? r.schedule.expression : "0 9 * * 1-5",
  timeZone: r.schedule.kind === "cron" ? r.schedule.timeZone : defaultTimeZone,
});
export function useRoutineEditor({
  botId,
  onClose,
  onConversation,
  initialRoutineId,
  remote,
}: {
  botId: string;
  remote?:
    | {
        workspaceId: string;
        read(query: RoutineQuery): Promise<RoutineView>;
        execute(input: Envelope): Promise<CommandResult>;
      }
    | undefined;
  initialRoutineId?: string | undefined;
  onClose(): void;
  onConversation(id: string): void;
}) {
  const key = `routine-editor:${remote ? `${remote.workspaceId}:` : ""}${botId}`;
  const api = useRef(remote);
  api.current = remote;
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { draft: fresh(), pending: null, error: "" };
      const saved = savedSchema.parse(JSON.parse(raw));
      if (
        saved.pending &&
        (!("botId" in saved.pending.command) ||
          saved.pending.command.botId !== botId) &&
        saved.pending.command.type !== "run.cancel"
      )
        throw Error("任务草稿归属无效。");
      return { ...saved, error: "" };
    } catch {
      return {
        draft: fresh(),
        pending: null,
        error: "任务草稿无法读取，原记录已保留。请先关闭并检查本地数据。",
      };
    }
  });
  const [draft, setDraft] = useState(initial.draft),
    [pending, setPending] = useState<Envelope | null>(initial.pending);
  const [view, setView] = useState<RoutineView | null>(null),
    [error, setError] = useState(initial.error),
    [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false),
    [before, setBefore] = useState<number | undefined>(),
    [secret, setSecret] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false),
    [notice, setNotice] = useState("");
  const mounted = useRef(true),
    locked = useRef(false),
    reload = useRef<() => void>(() => {});
  const requestedRoutine = useRef(initialRoutineId);
  const current = view?.routines.find((r) => r.id === draft.id);
  const saveLocal = (nextDraft: Draft, request: Envelope | null) =>
    localStorage.setItem(
      key,
      JSON.stringify({ draft: nextDraft, pending: request }),
    );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false,
      inflight = false;
    const load = async () => {
      if (disposed || inflight) return;
      inflight = true;
      try {
        const next = routineViewSchema.parse(
          await (api.current?.read ?? desktop.routines)({
            botId,
            routineId: draft.revision ? draft.id : undefined,
            before,
          }),
        );
        if (!disposed) {
          const requestedId = requestedRoutine.current;
          if (requestedId) {
            requestedRoutine.current = undefined;
            const selected = next.routines.find(
              (item) => item.id === requestedId,
            );
            const previous = next.routines.find(
              (item) => item.id === initial.draft.id,
            );
            const clean = previous
              ? JSON.stringify(edit(previous)) === JSON.stringify(initial.draft)
              : initial.draft.revision === 0 &&
                !initial.draft.name &&
                !initial.draft.prompt &&
                initial.draft.kind === "cron" &&
                initial.draft.expression === fresh().expression &&
                initial.draft.timeZone === fresh().timeZone;
            if (
              selected &&
              clean &&
              !initial.pending &&
              !initial.error &&
              !locked.current
            ) {
              const selectedDraft = edit(selected);
              try {
                localStorage.setItem(
                  key,
                  JSON.stringify({ draft: selectedDraft, pending: null }),
                );
                setDraft(selectedDraft);
              } catch (reason) {
                setError(`无法打开任务，原草稿已保留：${errorMessage(reason)}`);
              }
            } else if (requestedId !== initial.draft.id) {
              setNotice(
                selected
                  ? "已恢复未保存或待核实的任务草稿。处理后可从任务列表打开所选任务。"
                  : "所选任务已不存在，已保留原草稿。",
              );
            }
          }
          setView(next);
          setReadError("");
        }
      } catch (e) {
        if (!disposed) setReadError(errorMessage(e));
      } finally {
        inflight = false;
      }
    };
    reload.current = () => {
      void load();
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [botId, draft.id, draft.revision, before, initial, key]);
  const change = (next: Draft) => {
    try {
      requestedRoutine.current = undefined;
      saveLocal(next, null);
      setDraft(next);
      setError("");
      setNotice("");
    } catch (e) {
      setError(`草稿保存失败：${errorMessage(e)}`);
    }
  };
  const submit = async (
    command: Command,
    request?: Envelope,
    generatedSecret?: string,
  ) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    let committed = false;
    try {
      const accepted = request ?? pending ?? envelope(command);
      saveLocal(draft, accepted);
      setPending(accepted);
      const result = await (api.current?.execute ?? execute)(accepted);
      committed = true;
      // The committed acknowledgement owns this edit's revision. A later read may already include
      // another client's edit and must not silently rebase our still-unsaved input onto it.
      const nextDraft = {
        ...draft,
        revision: result.revision ?? draft.revision,
      };
      saveLocal(nextDraft, null);
      if (mounted.current) {
        setPending(null);
        setDraft(nextDraft);
        setBefore(undefined);
        setDeleteConfirm(false);
        setNotice(
          command.type === "routine.test"
            ? "真实测试已接受，请查看运行记录。"
            : command.type === "routine.key" && command.hash && !generatedSecret
              ? "密钥变更已确认；本次恢复无法显示原密钥，请重新轮换并保存新密钥。"
              : "已保存。",
        );
      }
      try {
        const next = routineViewSchema.parse(
          await (api.current?.read ?? desktop.routines)({
            botId,
            routineId: draft.id,
          }),
        );
        const saved = next.routines.find((r) => r.id === draft.id);
        const refreshedDraft = {
          ...nextDraft,
          ...(saved ? { enabled: saved.state === "active" } : {}),
        };
        saveLocal(refreshedDraft, null);
        if (mounted.current) {
          setView(next);
          setDraft(refreshedDraft);
          setReadError("");
          if (generatedSecret && saved?.revision === result.revision)
            setSecret(generatedSecret);
          if (
            result.revision !== undefined &&
            saved?.revision !== result.revision
          )
            setNotice(
              "本次修改已提交，但任务随后又有更新。输入已保留，请从任务列表载入最新版本后再编辑。",
            );
        }
      } catch (error) {
        if (mounted.current) {
          setReadError(errorMessage(error));
          if (generatedSecret)
            setNotice(
              "密钥变更已确认，但状态读取失败，暂不显示密钥。请重新轮换并保存新密钥。",
            );
        }
      }
    } catch (e) {
      if (
        !committed &&
        e instanceof AppError &&
        e.code !== "unknown" &&
        e.code !== "internal" &&
        e.code !== "unavailable"
      ) {
        try {
          saveLocal(draft, null);
          if (mounted.current) setPending(null);
        } catch {
          /* Keep the pending command so a later retry uses its original id. */
        }
      }
      if (mounted.current)
        setError(
          committed
            ? `操作已提交，但本机恢复记录未更新：${errorMessage(e)} 请重试原操作核实。`
            : `${errorMessage(e)}${!(e instanceof AppError) || e.code === "unknown" || e.code === "unavailable" ? " 结果待核实，请用重试原操作恢复，避免重复执行。" : ""}`,
        );
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const target = current
    ? { id: current.id, botId, revision: draft.revision }
    : null;
  const rotate = async () => {
    if (!target || locked.current) return;
    if (api.current) {
      setError("Webhook 密钥仅在目标 daemon 本机管理。");
      return;
    }
    setSecret("");
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const token = Array.from(bytes, (n) =>
        n.toString(16).padStart(2, "0"),
      ).join("");
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(token),
          ),
        ),
        (n) => n.toString(16).padStart(2, "0"),
      ).join("");
      await submit({ type: "routine.key", ...target, hash }, undefined, token);
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    }
  };
  const disabled = busy || !!pending || !!initial.error;
  return {
    botId,
    onClose,
    onConversation,
    draft,
    pending,
    view,
    error,
    readError,
    busy,
    before,
    setBefore,
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
  };
}
export type RoutineEditorViewModel = ReturnType<typeof useRoutineEditor>;
