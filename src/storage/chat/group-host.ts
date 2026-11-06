import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import { toolSchema } from "../../shared/chat/messages.js";
import {
  groupChoices,
  groupTurnLimit,
  type GroupHostState,
} from "../../shared/chat/group-host.js";
import type { GroupStorage } from "./groups.js";
import type { Job } from "../job.js";

export function migrateGroupHost(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE groups ADD COLUMN hostBotId TEXT;
    CREATE TABLE group_discussions(runId TEXT PRIMARY KEY REFERENCES runs(id),hostBotId TEXT NOT NULL,ending TEXT CHECK(ending IN('finish','wait','limit')));
  `);
}

export class GroupHostStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly context: {
      groups: GroupStorage;
      transaction<T>(work: () => T): T;
      changed(): void;
    },
  ) {}
  info(runId: string) {
    const row = this.db
      .prepare("SELECT hostBotId,ending FROM group_discussions WHERE runId=?")
      .get(runId);
    return row
      ? z
          .object({
            hostBotId: z.uuid(),
            ending: z.enum(["finish", "wait", "limit"]).nullable(),
          })
          .parse(row)
      : null;
  }
  instructions(job: Job) {
    const info = this.info(job.id);
    if (!info) return "";
    if (job.botId !== info.hostBotId)
      return "\n这是主持人组织的协作。依据用户目标和主持人最近的分工实际处理你的部分，报告结果、依据和未完成项；需要同伴协助时明确说出对象和问题。不要替其他成员声称已执行或已验证。";
    const ending = info.ending;
    const closing = {
      wait: "本次需要用户补充信息或授权，明确提出所需内容。",
      limit:
        "本次已到执行次数上限，必须说明尚未完成或未经验证的事项，不能声称任务已全部完成。",
      finish: "核对成员实际结果与证据，交付结论，保留尚未解决的分歧和限制。",
    };
    if (ending)
      return `\n你是本群主持人，现在负责收尾。${closing[ending]}本回合不要再调用有副作用的工具或安排新执行，只向用户作简洁汇报；不要输出 [[ASTER_PASS]]。`;
    return `\n你是本群主持人，对整个用户目标负责。${job.groupOrdinal === 0 ? "先理解需求，给出简短计划并按成员职责安排分工。简单问题可以直接回答，无需强行分工。" : "检查成员进展、遗漏、验证证据与分歧，必要时重新分工，推动任务完成。"}成员会据此执行；只陈述实际发生的操作。不要反复转述消息，没有必要时少说；需要用户补充信息时明确提问。不要输出 [[ASTER_PASS]]。`;
  }
  state(parent: Job): GroupHostState {
    const info = this.info(parent.id);
    const group = this.context.groups.read(parent.conversationId);
    if (!info || !group) throw new AppError("not_found", "主持讨论已不存在。");
    const members = group.memberIds.map((id) =>
      z
        .object({ id: z.uuid(), name: z.string(), description: z.string() })
        .parse(
          this.db
            .prepare(
              "SELECT id,name,description FROM bots WHERE id=? AND lifecycle='active'",
            )
            .get(id),
        ),
    );
    const rows = this.db
      .prepare(
        "SELECT id,role,botId,text,toolJson FROM messages WHERE runId=? ORDER BY sequence LIMIT 1001",
      )
      .all(parent.id);
    const messages = rows.map((row) => {
      const value = z
        .object({
          id: z.uuid(),
          role: z.string(),
          botId: z.uuid(),
          text: z.string(),
          toolJson: z.string().nullable(),
        })
        .parse(row);
      const tool = value.toolJson
        ? toolSchema.parse(JSON.parse(value.toolJson))
        : null;
      return {
        role: value.role,
        botId: value.botId,
        text: tool
          ? JSON.stringify({
              command: tool.command,
              status: tool.status,
              exitCode: tool.exitCode,
            })
          : value.text,
        attachments: this.db
          .prepare("SELECT name FROM attachments WHERE messageId=?")
          .all(value.id)
          .map((entry) => z.string().parse(entry.name)),
      };
    });
    const state = {
      hostBotId: info.hostBotId,
      members,
      messages,
      turns: this.context.groups.turns(parent.id),
    };
    if (rows.length > 1000 || JSON.stringify(state).length > 100000)
      throw new AppError(
        "capacity",
        "本次主持讨论的调度上下文超过限制，未发送不完整内容。",
      );
    return state;
  }
  advance(parent: Job, choice: string) {
    this.context.transaction(() => {
      if (
        this.db.prepare("SELECT status FROM runs WHERE id=?").get(parent.id)
          ?.status !== "running"
      )
        return;
      const info = this.info(parent.id);
      if (!info || info.ending) return;
      const turns = this.context.groups.turns(parent.id);
      if (
        turns.some(
          (turn) => turn.status === "queued" || turn.status === "running",
        )
      )
        throw new AppError("conflict", "当前成员尚未结束，未安排新成员。");
      if (
        turns.some(
          (turn) => turn.botId === info.hostBotId && turn.status === "failed",
        )
      )
        throw new AppError(
          "unavailable",
          "主持人运行失败，本次讨论已停止，未自动重试。",
        );
      const limited = turns.length >= groupTurnLimit - 1;
      const requestedEnding =
        choice === "finish" || choice === "wait" ? choice : null;
      const ending = limited ? "limit" : requestedEnding;
      if (!ending && !Object.hasOwn(groupChoices(this.state(parent)), choice))
        throw new AppError("unauthorized", "只能调度本群未失败的成员。");
      if (ending)
        this.db
          .prepare("UPDATE group_discussions SET ending=? WHERE runId=?")
          .run(ending, parent.id);
      // A host that already answered a simple request needs no second paraphrase.
      if (
        ending === "finish" &&
        turns.length === 1 &&
        turns[0]?.status === "completed" &&
        this.db
          .prepare(
            "SELECT 1 FROM messages WHERE runId=? AND role='assistant' AND toolJson IS NULL AND trim(text)<>'' LIMIT 1",
          )
          .get(parent.id)
      ) {
        this.context.changed();
        return;
      }
      this.db
        .prepare(
          "INSERT INTO group_turns(runId,ordinal,botId,status) VALUES(?,?,?,'queued')",
        )
        .run(parent.id, turns.length, ending ? info.hostBotId : choice);
      this.context.changed();
    });
  }
}
