import { desktopEnvelopeSchema } from "../../shared/desktop/desktop-commands.js";
import { workerRoutes } from "../../shared/protocol.js";
import { app, clipboard, dialog, nativeTheme } from "electron";
import { z } from "zod";
import {
  backupRequestSchema,
  backupStatusSchema,
  type BackupWorkerRequest,
} from "../../shared/backup.js";
import { AppError } from "../../shared/core.js";
import {
  diagnosticsRequestSchema,
  diagnosticsResultSchema,
} from "../../shared/diagnostics.js";
import {
  diagramSaveRequestSchema,
  diagramSaveResultSchema,
} from "../../shared/files/diagram-export.js";
import { preferencesChangeSchema } from "../../shared/desktop/preferences.js";
import { saveDiagramFile } from "../native/diagram-export.js";
import type { DesktopHandlerContext } from "./handler-context.js";
import { parseInput } from "./ipc-result.js";
export function registerNativeHandlers(
  ctx: Pick<
    DesktopHandlerContext,
    | "handle"
    | "window"
    | "draining"
    | "worker"
    | "runCommand"
    | "preferences"
    | "onPreferencesSaved"
    | "diagnostics"
    | "directoryConsent"
  >,
) {
  const { handle, worker, runCommand, preferences, diagnostics } = ctx;
  handle("diagnostics", async (input) => {
    const request = parseInput(diagnosticsRequestSchema, input);
    if (!ctx.window || ctx.draining)
      throw new AppError("unavailable", "窗口正在关闭，未开始诊断。");
    const owner = ctx.window;
    return diagnosticsResultSchema.parse(
      await diagnostics.request(request, async () => {
        const result = await dialog.showSaveDialog(owner, {
          title: "导出脱敏诊断",
          defaultPath: `aster-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
          filters: [{ name: "JSON 诊断报告", extensions: ["json"] }],
          properties: ["showOverwriteConfirmation"],
        });
        return result.canceled ? null : (result.filePath ?? null);
      }),
    );
  });
  handle("cancelDiagnostics", (input) => {
    diagnostics.cancel(parseInput(z.uuid(), input));
  });
  handle("backup", async (input) => {
    if (!ctx.window || ctx.draining)
      throw new AppError("unavailable", "窗口正在关闭，未开始备份。");
    const request = parseInput(backupRequestSchema, input);
    const ask = (body: BackupWorkerRequest) =>
      worker.call(workerRoutes.backup, body, undefined, 5 * 60 * 1000);
    if (request.action === "status" || request.action === "schedule-previous")
      return backupStatusSchema.parse(await ask(request));
    const owner = ctx.window;
    const chosen =
      request.action === "save"
        ? await dialog.showSaveDialog(owner, {
            title: "备份聊天数据库",
            defaultPath: `aster-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
            filters: [{ name: "SQLite 备份", extensions: ["sqlite"] }],
            properties: ["showOverwriteConfirmation"],
          })
        : await dialog.showOpenDialog(owner, {
            title: "选择要恢复的备份",
            filters: [{ name: "SQLite 备份", extensions: ["sqlite"] }],
            properties: ["openFile"],
          });
    const selected =
      "filePath" in chosen ? chosen.filePath : chosen.filePaths[0];
    if (chosen.canceled || !selected) {
      const status = backupStatusSchema.parse(await ask({ action: "status" }));
      return {
        ...status,
        notice: request.action === "save" ? "未保存备份。" : "未安排恢复。",
      };
    }
    return backupStatusSchema.parse(
      await ask(
        request.action === "save"
          ? { action: "save", path: selected }
          : { action: "schedule", path: selected },
      ),
    );
  });
  handle("saveDiagram", async (input) => {
    if (!ctx.window || ctx.draining)
      throw new AppError("unavailable", "窗口正在关闭，未导出图表。");
    const request = parseInput(diagramSaveRequestSchema, input);
    const owner = ctx.window;
    const chosen = await dialog.showSaveDialog(owner, {
      title: "导出图表",
      defaultPath: `aster-diagram-${new Date().toISOString().replace(/[:.]/g, "-")}.svg`,
      filters: [{ name: "SVG 图表", extensions: ["svg"] }],
      properties: ["showOverwriteConfirmation"],
    });
    if (chosen.canceled || !chosen.filePath)
      return diagramSaveResultSchema.parse({
        saved: false,
        notice: "未导出图表。",
      });
    const name = await saveDiagramFile(chosen.filePath, request.svg);
    return diagramSaveResultSchema.parse({
      saved: true,
      notice: `已导出：${name}`.slice(0, 500),
    });
  });
  handle("preferences", () => preferences.read());
  handle("savePreferences", async (input) => {
    if (ctx.draining)
      throw new AppError("unavailable", "界面正在退出，设置未接受。");
    const change = parseInput(preferencesChangeSchema, input);
    try {
      const saved = await preferences.save(change);
      ctx.onPreferencesSaved?.(saved);
      return saved;
    } finally {
      // Even an error after the atomic rename must reflect the committed preference.
      nativeTheme.themeSource = preferences.read().theme;
    }
  });
  handle(
    "command",
    (input) => {
      const envelope = parseInput(
        desktopEnvelopeSchema,
        input,
        "命令参数不符合接口约定。",
      );
      if (!ctx.window || ctx.draining)
        throw new AppError("unavailable", "窗口不可用，命令未接受。");
      return runCommand(
        ctx.directoryConsent.authorize(envelope, ctx.window.id),
      );
    },
    // [Invariant]: 命令可能已被后台提交；非领域错误必须提示保留原请求 ID 重试确认，而不是重新下发。
    {
      code: "unknown",
      message: "无法确认命令结果，请保留原请求重试确认。",
    },
  );
  handle("windowAction", (input) => {
    const action = parseInput(
      z.enum(["minimize", "maximize", "close", "quit"]),
      input,
    );
    if (action === "minimize") ctx.window?.minimize();
    else if (action === "close") ctx.window?.close();
    else if (action === "quit") app.quit();
    else if (ctx.window?.isMaximized()) ctx.window.unmaximize();
    else ctx.window?.maximize();
  });
  handle("copyText", (input) =>
    clipboard.writeText(parseInput(z.string().max(1024 * 1024), input)),
  );
}
