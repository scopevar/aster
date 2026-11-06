import type { ValidatedAvatar } from "../../avatars/image.js";
import { AppError } from "../../shared/core.js";
import { type Run } from "../../shared/chat/runs.js";
import { type QuestionInput } from "../../shared/chat/questions.js";
import { notificationRequestSchema } from "../../shared/chat/notifications.js";
import { skillToolRequestSchema } from "../../shared/tools/skill-tools.js";
import { templateToolRequestSchema } from "../../shared/templates/template-tools.js";
import type { ComputerTool } from "../../shared/tools/tool-calls.js";
import type { ScriptAction } from "../../shared/tools/scripts.js";
import type { ScriptApprovalDecision } from "../../shared/tools/approval-conditions.js";
import type { CommandContext } from "../commands/context.js";
import { captureTemplate } from "../commands/templates.js";
import { type Job } from "../job.js";
import type { QuestionStorage } from "./questions.js";
import type { RoutineTools } from "../../routines/tool.js";
import type { SkillToolStorage } from "./skill-tools.js";
import type { TemplateToolStorage } from "../templates/template-tools.js";
import type { ToolCallStorage } from "./tool-calls.js";

type Context = {
  transaction<T>(fn: () => T): T;
  canWrite(job: Job): boolean;
  getRun(id: string): Run | undefined;
  skillTools: SkillToolStorage;
  changed(): void;
  routineTools: RoutineTools;
  enqueueRoutine(
    botId: string,
    text: string,
  ): { id: string; conversationId: string };
  templateTools: TemplateToolStorage;
  commandContext(
    requestId?: string,
    validatedAvatar?: ValidatedAvatar,
  ): CommandContext;
  questions: QuestionStorage;
  toolCalls: ToolCallStorage;
};
export class ToolOperations {
  constructor(private readonly context: Context) {}

  private requireSkillAccess(job: Job) {
    if (
      !this.context.canWrite(job) ||
      this.context.getRun(job.id)?.status !== "running"
    )
      throw new AppError("unauthorized", "运行已经结束，不能继续访问技能。");
  }

  skillDiscoveryCatalog(job: Job) {
    this.requireSkillAccess(job);
    return this.context.skillTools.catalog(job);
  }

  skillToolRequest(job: Job, value: unknown) {
    const request = skillToolRequestSchema.parse(value);
    return this.context.transaction(() => {
      this.requireSkillAccess(job);
      const result = this.context.skillTools.request(
        job,
        request.callId,
        request.operation,
      );
      this.context.changed();
      return result;
    });
  }

  routineToolRequest(job: Job, value: unknown) {
    return this.context.routineTools.request(job, value);
  }

  notificationRequest(job: Job, value: unknown) {
    const request = notificationRequestSchema.parse(value);
    return this.context.transaction(() => {
      if (
        !this.context.canWrite(job) ||
        this.context.getRun(job.id)?.status !== "running"
      )
        throw new AppError("unauthorized", "运行已结束，不能继续发送通知。");
      const result = this.context.routineTools.notify(
        job,
        request.callId,
        request.text,
      );
      this.context.changed();
      return result;
    });
  }

  templateToolRequest(job: Job, value: unknown) {
    const request = templateToolRequestSchema.parse(value);
    return this.context.transaction(() => {
      if (
        !this.context.canWrite(job) ||
        this.context.getRun(job.id)?.status !== "running"
      )
        throw new AppError("unauthorized", "运行已结束，不能继续访问模板。");
      const result = this.context.templateTools.request(
        job,
        request.callId,
        request.operation,
        (skills, routines) =>
          captureTemplate(
            this.context.commandContext(),
            job.botId,
            skills,
            routines,
          ),
      );
      this.context.changed();
      return result;
    });
  }

  questionRequest(job: Job, callId: string, input: QuestionInput) {
    return this.context.transaction(() => {
      if (
        !this.context.canWrite(job) ||
        this.context.getRun(job.id)?.status !== "running"
      )
        throw new AppError("unauthorized", "运行已经结束，不能继续提出问题。");
      const question = this.context.questions.create(job, callId, input);
      this.context.changed();
      return question;
    });
  }

  toolRequest(job: Job, callId: string, action: ScriptAction, review = false) {
    return this.context.transaction(() => {
      if (
        !this.context.canWrite(job) ||
        this.context.getRun(job.id)?.status !== "running"
      )
        throw new AppError("unauthorized", "这次运行已经结束，不能执行脚本。");
      const call = this.context.toolCalls.request(job, callId, action);
      if (review) this.context.toolCalls.startReview(call.id);
      this.context.changed();
      return review ? this.context.toolCalls.get(call.id) : call;
    });
  }

  toolGet(id: string) {
    return this.context.toolCalls.get(id);
  }
  toolReviewRequests(job: Job) {
    if (
      !this.context.canWrite(job) ||
      this.context.getRun(job.id)?.status !== "running"
    )
      throw new AppError("unauthorized", "本轮自动审核授权已结束。");
    return this.context.toolCalls.reviewRequests(job);
  }
  toolReviewFinish(job: Job, id: string, result: ScriptApprovalDecision) {
    this.context.transaction(() => {
      if (
        !this.context.canWrite(job) ||
        this.context.getRun(job.id)?.status !== "running"
      )
        return;
      const call = this.context.toolCalls.get(id);
      if (
        call.runId !== job.id ||
        call.botId !== job.botId ||
        call.conversationId !== job.conversationId
      )
        throw new AppError("unauthorized", "审核不属于当前运行。");
      this.context.toolCalls.finishReview(id, result);
      this.context.changed();
    });
  }

  toolClaim(job: Job, id: string) {
    return this.context.transaction(() => {
      const call = this.context.toolCalls.get(id);
      if (
        call.runId !== job.id ||
        call.botId !== job.botId ||
        call.conversationId !== job.conversationId
      )
        throw new AppError("unauthorized", "工具调用不属于当前运行。");
      if (
        !this.context.canWrite(job) ||
        this.context.getRun(job.id)?.status !== "running"
      ) {
        this.context.toolCalls.cancel(id);
        this.context.changed();
        return null;
      }
      const claimed = this.context.toolCalls.claim(id);
      this.context.changed();
      return claimed;
    });
  }

  toolCancel(id: string) {
    this.context.transaction(() => {
      this.context.toolCalls.cancel(id);
      this.context.changed();
    });
  }

  toolFinish(id: string, status: ComputerTool["status"], detail: string) {
    this.context.transaction(() => {
      this.context.toolCalls.finish(id, status, detail);
      this.context.changed();
    });
  }

  toolImage(id: string, conversationId: string) {
    return this.context.toolCalls.image(id, conversationId);
  }
}
