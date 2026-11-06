import type { ToolExecution } from "../shared/chat/messages.js";
import type { Usage } from "../shared/chat/usage.js";
import type { AgentAttachment } from "../shared/files/attachments.js";
import type { StructuredModel } from "../shared/memory.js";
import type { ContextUsage } from "../shared/chat/context-budget.js";

export type AgentEvent =
  | { type: "tool"; itemId: string; tool: ToolExecution }
  | { type: "tool-output"; itemId: string; delta: string }
  | { type: "text"; itemId: string; text: string; complete: boolean }
  | { type: "turn"; turnId: string }
  | { type: "thread"; threadId: string }
  | { type: "context-usage"; usage: ContextUsage }
  | { type: "file"; name: string; data: Uint8Array };
export interface AgentInput {
  runId?: string;
  isRunCancelled?(runId: string): boolean;
  sessionScope?: { conversationId: string; botId: string };
  toolAccess?: { port: number; token: string };
  threadId: string | null;
  restartThread?: boolean;
  text: string;
  instructions: string;
  workspace: string;
  signal: AbortSignal;
  attachments?: AgentAttachment[];
  onEvent(event: AgentEvent): void;
}
export interface AgentResult {
  status: "completed" | "cancelled" | "failed";
  error: string | null;
}
export interface Agent {
  readonly retainCancelledContext?: boolean;
  capture?(botId?: string): Agent & Partial<StructuredModel>;
  requiresFreshSession?(
    threadId: string | null,
    workspace: string,
  ): boolean | Promise<boolean>;
  check(signal?: AbortSignal): Promise<{
    accountType: string | null;
    detail: string;
    usage?: Usage;
  }>;
  run(input: AgentInput): Promise<AgentResult>;
  cleanThreads?(
    workspace: string,
    threadIds: readonly string[] | undefined,
    signal: AbortSignal,
    knownThreadIds?: readonly string[],
  ): Promise<void>;
}
