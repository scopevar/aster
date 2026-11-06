import type { AgentConnections } from "../agent/connections.js";
import type { Job, Store } from "../storage/store.js";
import type { ScriptAction } from "../shared/tools/scripts.js";
import type { ScriptApprovalDecision } from "../shared/tools/approval-conditions.js";
import { AppError } from "../shared/core.js";
import {
  scriptApprovalChoices,
  scriptApprovalInstructions,
} from "./approval-policy.js";
import { sandboxLimits } from "./protocol.js";
import { scriptInputPath } from "./workspace.js";

/** A review belongs to one exact pending call; every other outcome returns control to its user. */
export class ScriptApprovals {
  constructor(
    private readonly store: Pick<
      Store,
      "files" | "runs" | "subscribe" | "toolOperations"
    >,
    private readonly connections: AgentConnections,
  ) {}

  async review(
    job: Job,
    id: string,
    action: ScriptAction,
    signal: AbortSignal,
  ) {
    const controller = new AbortController();
    const current = () => {
      try {
        const call = this.store.toolOperations.toolGet(id);
        if (
          !this.store.runs.canWrite(job) ||
          call.status !== "pending" ||
          call.review?.state !== "reviewing"
        )
          controller.abort();
      } catch {
        controller.abort();
      }
    };
    const unsubscribe = this.store.subscribe(current);
    current();
    const combined = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    let result: ScriptApprovalDecision;
    try {
      combined.throwIfAborted();
      const client = await this.connections.scriptReviewer();
      if (!client)
        result = {
          decision: "ask",
          reason: "Jev 未启用，请你确认本次脚本与联网范围。",
        };
      else {
        const state = {
          userRequests: this.store.toolOperations.toolReviewRequests(job),
          action,
          inputs: job.attachments.map((file) => ({
            name: file.name,
            path: scriptInputPath(file),
          })),
          environment: {
            kind: "isolated_linux_vm",
            writableRoots: ["/workspace"],
            readOnlyRoots: ["/inputs"],
            hostFilesystem: false,
            credentials: false,
            network:
              "Only declared public DNS hosts over HTTPS/443; disabled when list is empty.",
            commandMs: sandboxLimits.commandMs,
            memoryMiB: sandboxLimits.memoryMiB,
          },
        };
        if (JSON.stringify(state).length > 64000)
          result = {
            decision: "ask",
            reason: "本次指令或脚本超过 Jev 审核范围，请你确认。",
          };
        else {
          const answer = await client.choose(
            state,
            scriptApprovalChoices,
            scriptApprovalInstructions,
            combined,
          );
          combined.throwIfAborted();
          const allow =
            answer.choice !== "ask" &&
            answer.confidence >= 0.9 &&
            (answer.probabilities[answer.choice] ?? 0) >= 0.9;
          const category =
            answer.choice === "public_read"
              ? "公开信息只读查询"
              : "本轮工作区处理";
          let reason = "Jev 判断未达到自动放行要求，请你确认后再执行。";
          if (answer.choice === "ask")
            reason = "Jev 判断本次操作需要人工确认，脚本尚未执行。";
          if (allow)
            reason = `Jev 已通过：${category}，置信度 ${Math.round(answer.confidence * 100)}%。仅允许本次具体命令和联网范围。`;
          result = {
            decision: allow ? "allow" : "ask",
            confidence: answer.confidence,
            reason,
          };
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      result = {
        decision: "ask",
        reason:
          `${error instanceof AppError ? error.message : "Jev 审核超时、连接失败或结果无效。"} 已转人工确认，脚本尚未执行。`.slice(
            0,
            600,
          ),
      };
    } finally {
      unsubscribe();
    }
    signal.throwIfAborted();
    if (controller.signal.aborted) return;
    this.store.toolOperations.toolReviewFinish(job, id, result);
  }
}
