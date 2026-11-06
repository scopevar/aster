import { desktopEnvelopeSchema } from "../../shared/desktop/desktop-commands.js";
import type { DesktopEnvelope as Envelope } from "../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../shared/desktop/desktop-commands.js";
import { resultSchema, AppError } from "../../shared/core.js";
import { snapshotUpdateSchema, type Query } from "../../shared/snapshot.js";
import type {
  DesktopApi,
  DesktopArgs,
  DesktopBridge,
  DesktopData,
  DesktopMethod,
  DesktopSubscriptions,
  Result,
} from "../../shared/ipc-contracts.js";
import {
  messageSearchResultSchema,
  messageHistoryResultSchema,
  type MessageSearchQuery,
  type MessageHistoryQuery,
} from "../../shared/chat/message-search.js";
import {
  appUpdateStateSchema,
  type AppUpdateRequest,
  type AppUpdateState,
} from "../../shared/desktop/app-update.js";
import {
  workerSignalSchema,
  type WorkerSignal,
} from "../../shared/worker-events.js";
declare global {
  interface Window {
    aster: DesktopBridge;
    asterEvents: DesktopSubscriptions;
  }
}

/** 跨进程只传 Result；AppError 在渲染层内部重建，以保留 code 供调用方区分“确定未提交”与“结果未知”。 */
export function unwrap<T>(result: Result<T>): T {
  if (result.success) return result.data;
  throw new AppError(result.error.code, result.error.message);
}

export function createDesktopClient(bridge: () => DesktopBridge): DesktopApi {
  const call =
    <K extends DesktopMethod>(method: K) =>
    async (...args: DesktopArgs<K>): Promise<DesktopData<K>> =>
      unwrap(await bridge()[method](...args));
  return {
    sandboxSettings: call("sandboxSettings"),
    localWorkspace: call("localWorkspace"),
    templateFile: call("templateFile"),
    plugins: call("plugins"),
    agentConnections: call("agentConnections"),
    diagnostics: call("diagnostics"),
    cancelDiagnostics: call("cancelDiagnostics"),
    backup: call("backup"),
    saveDiagram: call("saveDiagram"),
    templates: call("templates"),
    routines: call("routines"),
    openRoutineWindow: call("openRoutineWindow"),
    focusConversation: call("focusConversation"),
    openDocumentLink: call("openDocumentLink"),
    documentPreview: call("documentPreview"),
    cancelDocumentPreview: call("cancelDocumentPreview"),
    toolImage: call("toolImage"),
    memory: call("memory"),
    sharedMemory: call("sharedMemory"),
    skillCatalog: call("skillCatalog"),
    skillContent: call("skillContent"),
    avatarContent: call("avatarContent"),
    uploadAttachment: call("uploadAttachment"),
    cancelUpload: call("cancelUpload"),
    attachmentContent: call("attachmentContent"),
    saveAttachment: call("saveAttachment"),
    chooseDirectory: call("chooseDirectory"),
    preferences: call("preferences"),
    savePreferences: call("savePreferences"),
    appUpdate: call("appUpdate"),
    snapshot: call("snapshot"),
    workerStatus: call("workerStatus"),
    messageSearch: call("messageSearch"),
    messageHistory: call("messageHistory"),
    command: call("command"),
    copyText: call("copyText"),
    windowAction: call("windowAction"),
    routineWindowAction: call("routineWindowAction"),
  };
}

export const desktop = createDesktopClient(() => window.aster);

export function envelope(command: Command): Envelope {
  return desktopEnvelopeSchema.parse({
    id: crypto.randomUUID(),
    command,
  });
}
export async function execute(request: Envelope) {
  return resultSchema.parse(await desktop.command(request));
}
/** 带游标的读取：后台数据未变化时返回 undefined，调用方保留当前状态。 */
export async function snapshotSince(query: Query) {
  const update = snapshotUpdateSchema.parse(await desktop.snapshot(query));
  return update.changed ? update.snapshot : undefined;
}
export async function workerStatus() {
  return workerSignalSchema.parse(await desktop.workerStatus());
}
export function subscribeAppUpdate(
  listener: (state: AppUpdateState) => void,
  events: () => DesktopSubscriptions = () => window.asterEvents,
) {
  return events().onAppUpdate((payload) => {
    const state = appUpdateStateSchema.safeParse(payload);
    if (state.success) listener(state.data);
  });
}
export function subscribeFocusConversation(listener: (id: string) => void) {
  return window.asterEvents.onFocusConversation((payload) => {
    if (typeof payload === "string" && payload) listener(payload);
  });
}
export async function appUpdate(request: AppUpdateRequest) {
  return appUpdateStateSchema.parse(await desktop.appUpdate(request));
}
export function subscribeWorker(
  listener: (signal: WorkerSignal) => void,
  events: () => DesktopSubscriptions = () => window.asterEvents,
) {
  return events().onWorkerSignal((payload) => {
    const signal = workerSignalSchema.safeParse(payload);
    if (signal.success) listener(signal.data);
  });
}
export async function snapshot(query: Omit<Query, "since">) {
  const view = await snapshotSince(query);
  if (!view) throw new AppError("internal", "后台返回了无效的快照结果。");
  return view;
}
export async function messageSearch(query: MessageSearchQuery) {
  return messageSearchResultSchema.parse(await desktop.messageSearch(query));
}
export async function messageHistory(query: MessageHistoryQuery) {
  return messageHistoryResultSchema.parse(await desktop.messageHistory(query));
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "操作失败，请保留输入后重试。";
}
