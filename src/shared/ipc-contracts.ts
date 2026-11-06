import type {
  LocalWorkspaceRequest,
  LocalWorkspaceStatus,
} from "./local-workspace.js";
import type {
  SandboxSettingsRequest,
  SandboxSettingsStatus,
} from "./tools/sandbox-settings.js";
import type { PluginsRequest, PluginsResponse } from "./tools/plugins.js";
import type { DesktopEnvelope } from "./desktop/desktop-commands.js";
import type { z } from "zod";
import type {
  AgentConnectionsRequest,
  AgentConnectionsStatus,
} from "./agent-connections.js";
import type { CommandResult, Failure } from "./core.js";
import type { Query, SnapshotUpdate } from "./snapshot.js";
import type {
  MessageSearchQuery,
  MessageSearchResult,
  MessageHistoryQuery,
  MessageHistoryResult,
} from "./chat/message-search.js";
import type { WorkerSignal } from "./worker-events.js";
import type { DiagnosticsRequest, DiagnosticsResult } from "./diagnostics.js";
import type { BackupRequest, BackupStatus } from "./backup.js";
import type {
  DiagramSaveRequest,
  DiagramSaveResult,
} from "./files/diagram-export.js";
import type {
  TemplatesQuery,
  TemplatesResponse,
  TemplateFileRequest,
  TemplateFileResult,
} from "./templates/templates.js";
import type { RoutineQuery, RoutineView } from "./routines.js";
import type { OfficePreviewRequest, OfficeResult } from "./files/office.js";
import type {
  toolImageAccessSchema,
  toolImageSchema,
} from "./tools/tool-calls.js";
import type {
  MemoryScope,
  MemoryView,
  SharedMemoryScope,
  SharedMemoryView,
} from "./memory.js";
import type {
  skillSummarySchema,
  SkillReference,
  Skill,
} from "./tools/skills.js";
import type { AppUpdateRequest, AppUpdateState } from "./desktop/app-update.js";
import type {
  DesktopPreferences,
  PreferencesChange,
} from "./desktop/preferences.js";
import type { AvatarAccess, AvatarContent } from "./avatar.js";
import type {
  AttachmentInput,
  Attachment,
  AttachmentAccess,
  AttachmentContent,
} from "./files/attachments.js";

// [Security]: 本文件会被打包进 sandbox preload，只允许 type-only 导入；
// 引入运行时依赖会把 schema/数据表整体带进 preload 并扩大其攻击面。

/** 跨进程边界的统一结果模型；error 只携带可结构化克隆的纯数据。 */
export type Result<T> =
  | { success: true; data: T }
  | { success: false; error: Failure };

/**
 * Renderer 可调用的全部桌面能力（语义视图）。
 * 每个方法对应一个 `aster:<方法名>` channel，preload 与 main 都从这里推导，不再各写一份字符串。
 */
export interface DesktopApi {
  sandboxSettings(
    request: SandboxSettingsRequest,
  ): Promise<SandboxSettingsStatus>;
  localWorkspace(request: LocalWorkspaceRequest): Promise<LocalWorkspaceStatus>;
  templateFile(request: TemplateFileRequest): Promise<TemplateFileResult>;
  plugins(request: PluginsRequest): Promise<PluginsResponse>;
  agentConnections(
    request: AgentConnectionsRequest,
  ): Promise<AgentConnectionsStatus>;
  diagnostics(request: DiagnosticsRequest): Promise<DiagnosticsResult>;
  cancelDiagnostics(requestId: string): Promise<void>;
  backup(request: BackupRequest): Promise<BackupStatus>;
  saveDiagram(request: DiagramSaveRequest): Promise<DiagramSaveResult>;
  templates(query: TemplatesQuery): Promise<TemplatesResponse>;
  routines(query: RoutineQuery): Promise<RoutineView>;
  openRoutineWindow(botId: string, routineId?: string): Promise<void>;
  focusConversation(conversationId: string): Promise<void>;
  openDocumentLink(url: string): Promise<void>;
  documentPreview(request: OfficePreviewRequest): Promise<OfficeResult>;
  cancelDocumentPreview(requestId: string): Promise<void>;
  toolImage(
    access: z.infer<typeof toolImageAccessSchema>,
  ): Promise<z.infer<typeof toolImageSchema>>;
  memory(scope: MemoryScope): Promise<MemoryView>;
  sharedMemory(scope: SharedMemoryScope): Promise<SharedMemoryView>;
  skillCatalog(botIds: string[]): Promise<z.infer<typeof skillSummarySchema>[]>;
  skillContent(access: SkillReference): Promise<Skill>;
  avatarContent(access: AvatarAccess): Promise<AvatarContent>;
  uploadAttachment(
    input: AttachmentInput,
    bytes: Uint8Array,
  ): Promise<Attachment>;
  cancelUpload(id: string): Promise<void>;
  attachmentContent(access: AttachmentAccess): Promise<AttachmentContent>;
  saveAttachment(access: AttachmentAccess): Promise<boolean>;
  chooseDirectory(conversationId: string): Promise<string | null>;
  preferences(): Promise<DesktopPreferences>;
  savePreferences(change: PreferencesChange): Promise<DesktopPreferences>;
  appUpdate(request: AppUpdateRequest): Promise<AppUpdateState>;
  snapshot(query: Query): Promise<SnapshotUpdate>;
  /** 推送通道的当前状态；界面挂载时先取一次，之后由 `onWorkerSignal` 增量更新。 */
  workerStatus(): Promise<WorkerSignal>;
  messageSearch(query: MessageSearchQuery): Promise<MessageSearchResult>;
  messageHistory(query: MessageHistoryQuery): Promise<MessageHistoryResult>;
  command(envelope: DesktopEnvelope): Promise<CommandResult>;
  copyText(text: string): Promise<void>;
  windowAction(
    action: "minimize" | "maximize" | "close" | "quit",
  ): Promise<void>;
  routineWindowAction(action: "minimize" | "maximize" | "close"): Promise<void>;
}

export type DesktopMethod = keyof DesktopApi;
export type DesktopArgs<K extends DesktopMethod> = Parameters<DesktopApi[K]>;
export type DesktopData<K extends DesktopMethod> = Awaited<
  ReturnType<DesktopApi[K]>
>;

/** Preload 暴露到 `window.aster` 的真实形状：所有调用都 resolve 为 Result，不会 reject。 */
export type DesktopBridge = {
  [K in DesktopMethod]: (
    ...args: DesktopArgs<K>
  ) => Promise<Result<DesktopData<K>>>;
};

export type DesktopChannel = `aster:${DesktopMethod}`;

export function desktopChannel<K extends DesktopMethod>(
  method: K,
): `aster:${K}` {
  return `aster:${method}`;
}

/**
 * 以注入的 invoke 构造 bridge，使 preload 不依赖可被测试替换之外的任何东西。
 * 方法列表显式书写而非遍历生成：遍历需要把 string 断言回方法名，会绕过类型检查。
 */
export function createDesktopBridge(
  invoke: <T>(channel: DesktopChannel, ...args: unknown[]) => Promise<T>,
): DesktopBridge {
  const bind =
    <K extends DesktopMethod>(method: K) =>
    (...args: DesktopArgs<K>) =>
      invoke<Result<DesktopData<K>>>(desktopChannel(method), ...args);
  return {
    sandboxSettings: bind("sandboxSettings"),
    localWorkspace: bind("localWorkspace"),
    templateFile: bind("templateFile"),
    plugins: bind("plugins"),
    agentConnections: bind("agentConnections"),
    diagnostics: bind("diagnostics"),
    cancelDiagnostics: bind("cancelDiagnostics"),
    backup: bind("backup"),
    saveDiagram: bind("saveDiagram"),
    templates: bind("templates"),
    routines: bind("routines"),
    openRoutineWindow: bind("openRoutineWindow"),
    focusConversation: bind("focusConversation"),
    openDocumentLink: bind("openDocumentLink"),
    documentPreview: bind("documentPreview"),
    cancelDocumentPreview: bind("cancelDocumentPreview"),
    toolImage: bind("toolImage"),
    memory: bind("memory"),
    sharedMemory: bind("sharedMemory"),
    skillCatalog: bind("skillCatalog"),
    skillContent: bind("skillContent"),
    avatarContent: bind("avatarContent"),
    uploadAttachment: bind("uploadAttachment"),
    cancelUpload: bind("cancelUpload"),
    attachmentContent: bind("attachmentContent"),
    saveAttachment: bind("saveAttachment"),
    chooseDirectory: bind("chooseDirectory"),
    preferences: bind("preferences"),
    savePreferences: bind("savePreferences"),
    appUpdate: bind("appUpdate"),
    snapshot: bind("snapshot"),
    workerStatus: bind("workerStatus"),
    messageSearch: bind("messageSearch"),
    messageHistory: bind("messageHistory"),
    command: bind("command"),
    copyText: bind("copyText"),
    windowAction: bind("windowAction"),
    routineWindowAction: bind("routineWindowAction"),
  };
}

/** 主进程 → Renderer 的推送事件及其载荷。载荷只能是元数据，不得携带用户数据。 */
export interface DesktopEvents {
  workerSignal: WorkerSignal;
  appUpdate: AppUpdateState;
  focusConversation: string;
}

export type DesktopEvent = keyof DesktopEvents;
export type DesktopEventChannel = `aster-event:${DesktopEvent}`;

export function desktopEventChannel<K extends DesktopEvent>(
  event: K,
): `aster-event:${K}` {
  return `aster-event:${event}`;
}

/**
 * Preload 暴露到 `window.asterEvents` 的订阅接口。与 DesktopBridge 分开：
 * 订阅不是一次 invoke，混在一起会让“逐个调用 bridge 方法”的契约测试误注册监听。
 * [Security]: 载荷以 unknown 交给 Renderer，由 Renderer 用 schema 校验；preload 不引入运行时 schema。
 */
export interface DesktopSubscriptions {
  /** 返回值必须在订阅者生命周期结束时调用，否则 ipcRenderer 监听会随组件重挂载累积。 */
  onWorkerSignal(listener: (payload: unknown) => void): () => void;
  onAppUpdate(listener: (payload: unknown) => void): () => void;
  onFocusConversation(listener: (payload: unknown) => void): () => void;
}

export function createDesktopSubscriptions(
  listen: (
    channel: DesktopEventChannel,
    listener: (payload: unknown) => void,
  ) => () => void,
): DesktopSubscriptions {
  return {
    onWorkerSignal: (listener) =>
      listen(desktopEventChannel("workerSignal"), listener),
    onAppUpdate: (listener) =>
      listen(desktopEventChannel("appUpdate"), listener),
    onFocusConversation: (listener) =>
      listen(desktopEventChannel("focusConversation"), listener),
  };
}
