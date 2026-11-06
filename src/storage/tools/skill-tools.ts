import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  skillSchema,
  summarizeSkill,
  type Skill,
} from "../../shared/tools/skills.js";
import {
  skillToolResultSchema,
  type SkillOperation,
  type SkillToolResult,
} from "../../shared/tools/skill-tools.js";
import type { Job } from "../store.js";
import type { SkillStorage } from "./skills.js";

/** Store validates the live run and owns the enclosing synchronous transaction. */
export class SkillToolStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly skills: SkillStorage,
  ) {}
  migrate() {
    this.db.exec(`CREATE TABLE skill_tool_calls(
      runId TEXT NOT NULL REFERENCES runs(id), ordinal INTEGER NOT NULL,
      callId TEXT NOT NULL, fingerprint TEXT NOT NULL, resultJson TEXT NOT NULL,
      PRIMARY KEY(runId,ordinal,callId));`);
  }
  private shared(job: Job): Skill[] {
    if (job.groupOrdinal === undefined)
      throw new AppError("internal", "群聊技能读取缺少成员轮次。");
    // Only user-shared frozen content that this member has actually received.
    const rows = this.db
      .prepare(
        `SELECT m.skillsJson FROM messages m WHERE m.conversationId=? AND m.role='user' AND m.skillsJson<>'[]' AND (
      EXISTS(SELECT 1 FROM group_context c WHERE c.conversationId=m.conversationId AND c.botId=? AND c.messageId=m.id)
      OR EXISTS(SELECT 1 FROM group_turn_context c WHERE c.runId=? AND c.ordinal=? AND c.messageId=m.id)) ORDER BY m.sequence`,
      )
      .iterate(job.conversationId, job.botId, job.id, job.groupOrdinal);
    const versions = new Map<string, Skill>();
    for (const row of rows) {
      const values = z
        .array(skillSchema)
        .max(4)
        .parse(JSON.parse(z.string().parse(row.skillsJson)));
      for (const skill of values) {
        versions.set(`${skill.id}:${skill.revision}`, skill);
        if (versions.size > 100)
          throw new AppError(
            "capacity",
            "此群聊共享技能版本超过单次目录上限，请通过已有消息引用查看。",
          );
      }
    }
    return [...versions.values()];
  }
  private readPrivate(botId: string, id: string, revision: number) {
    const live = this.db
      .prepare(
        "SELECT revision FROM skills WHERE id=? AND botId=? AND deleted=0",
      )
      .get(id, botId);
    if (!live)
      throw new AppError("not_found", "技能不存在、已删除或不属于当前 Bot。");
    if (live.revision !== revision)
      throw new AppError("conflict", "技能版本已改变，请重新读取目录。");
    return this.skills.content({ botId, id, revision });
  }
  catalog(job: Job) {
    return job.groupOrdinal === undefined
      ? this.skills.list([job.botId])
      : this.shared(job).map(summarizeSkill);
  }
  request(
    job: Job,
    callId: string,
    operation: SkillOperation,
  ): SkillToolResult {
    const ordinal = job.groupOrdinal ?? -1;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(operation))
      .digest("hex");
    const prior = this.db
      .prepare(
        "SELECT fingerprint,resultJson FROM skill_tool_calls WHERE runId=? AND ordinal=? AND callId=?",
      )
      .get(job.id, ordinal, callId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new AppError("conflict", "相同技能调用编号不能改变参数。");
      return skillToolResultSchema.parse(
        JSON.parse(z.string().parse(prior.resultJson)),
      );
    }
    const count = z
      .number()
      .parse(
        this.db
          .prepare("SELECT count(*) n FROM skill_tool_calls WHERE runId=?")
          .get(job.id)?.n,
      );
    if (count >= 24)
      throw new AppError("capacity", "本轮技能调用已达 24 次上限。");
    let result: SkillToolResult;
    if (operation.action === "list") {
      result = {
        action: "list",
        skills: this.catalog(job),
      };
    } else if (operation.action === "read") {
      const skill =
        job.groupOrdinal === undefined
          ? this.readPrivate(job.botId, operation.id, operation.revision)
          : this.shared(job).find(
              (s) => s.id === operation.id && s.revision === operation.revision,
            );
      if (!skill)
        throw new AppError(
          "unauthorized",
          "这个技能版本未向当前群成员明确共享。",
        );
      result = { action: "read", skill };
    } else {
      if (job.groupOrdinal !== undefined)
        throw new AppError(
          "unauthorized",
          "群聊不能修改成员私有技能，请在该 Bot 的私聊中处理。",
        );
      const previous =
        operation.action === "create"
          ? null
          : this.readPrivate(job.botId, operation.id, operation.revision);
      let skill: Skill;
      if (operation.action === "delete") {
        this.skills.remove({
          type: "skill.delete",
          botId: job.botId,
          id: operation.id,
          revision: operation.revision,
        });
        if (!previous)
          throw new AppError("internal", "删除技能缺少已验证的原版本。");
        skill = previous;
      } else {
        const id = operation.action === "create" ? randomUUID() : operation.id;
        const revision = operation.action === "create" ? 0 : operation.revision;
        this.skills.save({
          type: "skill.save",
          id,
          revision,
          botId: job.botId,
          name: operation.name,
          description: operation.description,
          body: operation.body,
        });
        skill = this.skills.content({
          id,
          botId: job.botId,
          revision: revision + 1,
        });
      }
      const messageId = randomUUID();
      const verb = {
        create: "已创建技能",
        update: "已更新技能",
        delete: "已删除技能",
      }[operation.action];
      // Existing skill chips open the exact immutable version, including after deletion.
      this.db
        .prepare(
          "INSERT INTO messages(id,botId,conversationId,role,text,createdAt,runId,itemId,skillsJson) VALUES(?,?,?,'assistant',?,?,?,?,?)",
        )
        .run(
          messageId,
          job.botId,
          job.conversationId,
          `${verb}：${skill.name} · v${skill.revision}`,
          Date.now(),
          job.id,
          `skill:${messageId}`,
          JSON.stringify([skill]),
        );
      result = {
        action: operation.action,
        skill: summarizeSkill(skill),
        messageId,
      };
    }
    const checked = skillToolResultSchema.parse(result);
    const resultJson = JSON.stringify(checked);
    const bytes = z
      .number()
      .parse(
        this.db
          .prepare(
            "SELECT coalesce(sum(length(CAST(resultJson AS BLOB))),0) n FROM skill_tool_calls",
          )
          .get()?.n,
      );
    if (bytes + Buffer.byteLength(resultJson) > 64 * 1024 * 1024)
      throw new AppError(
        "capacity",
        "技能调用记录达到 64 MiB 上限，操作未提交。",
      );
    this.db
      .prepare("INSERT INTO skill_tool_calls VALUES(?,?,?,?,?)")
      .run(job.id, ordinal, callId, fingerprint, resultJson);
    return checked;
  }
}
