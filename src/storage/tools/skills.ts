import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  skillSchema,
  skillSummarySchema,
  type SkillReference,
  type Skill,
  type skillSaveSchema,
  type skillDeleteSchema,
} from "../../shared/tools/skills.js";

/** Called only inside Store's transactions; immutable revisions remain available to sent messages. */
export class SkillStorage {
  constructor(private readonly db: DatabaseSync) {}
  migrate() {
    this.db.exec(`
    CREATE TABLE skills(id TEXT PRIMARY KEY,botId TEXT NOT NULL REFERENCES bots(id),revision INTEGER NOT NULL,nameKey TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX active_skill_name ON skills(botId,nameKey) WHERE deleted=0;
    CREATE TABLE skill_versions(id TEXT NOT NULL REFERENCES skills(id),revision INTEGER NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,body TEXT NOT NULL,updatedAt INTEGER NOT NULL,PRIMARY KEY(id,revision));
    ALTER TABLE conversations ADD COLUMN draftSkillsJson TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE messages ADD COLUMN skillsJson TEXT NOT NULL DEFAULT '[]';
  `);
  }
  content(ref: SkillReference): Skill {
    const row = this.db
      .prepare(
        "SELECT v.*,s.botId FROM skill_versions v JOIN skills s ON s.id=v.id WHERE v.id=? AND v.revision=? AND s.botId=?",
      )
      .get(ref.id, ref.revision, ref.botId);
    if (!row) throw new AppError("not_found", "技能版本不存在或不属于该 Bot。");
    return skillSchema.parse(row);
  }
  list(botIds: string[]) {
    return botIds.flatMap((botId) =>
      this.db
        .prepare(
          "SELECT v.id,v.revision,v.name,v.description,v.updatedAt,s.botId FROM skills s JOIN skill_versions v ON v.id=s.id AND v.revision=s.revision WHERE s.botId=? AND s.deleted=0 ORDER BY v.name,s.id",
        )
        .all(botId)
        .map((r) => skillSummarySchema.parse(r)),
    );
  }
  freeze(refs: SkillReference[], botIds: string[]) {
    if (new Set(refs.map((r) => r.id)).size !== refs.length)
      throw new AppError("invalid_input", "技能不能重复引用。");
    return refs.map((ref) => {
      if (!botIds.includes(ref.botId))
        throw new AppError("unauthorized", "技能不属于当前 Bot 或群成员。");
      const row = this.db
        .prepare("SELECT deleted FROM skills WHERE id=? AND botId=?")
        .get(ref.id, ref.botId);
      if (!row || row.deleted !== 0)
        throw new AppError(
          "conflict",
          "引用的技能已删除，请移除引用或重新选择。",
        );
      return this.content(ref);
    });
  }
  save(command: z.infer<typeof skillSaveSchema>) {
    const existing = this.db
      .prepare("SELECT * FROM skills WHERE id=?")
      .get(command.id);
    if (
      existing &&
      (existing.botId !== command.botId ||
        existing.revision !== command.revision ||
        existing.deleted !== 0)
    )
      throw new AppError("conflict", "技能已修改或删除，请重新读取后编辑。");
    if (!existing && command.revision !== 0)
      throw new AppError("not_found", "技能不存在。");
    if (!existing) {
      const count = this.db
        .prepare("SELECT count(*) n FROM skills WHERE botId=? AND deleted=0")
        .get(command.botId)?.n;
      if (z.number().parse(count) >= 100)
        throw new AppError("capacity", "每个 Bot 最多 100 个技能。");
    }
    const nameKey = command.name.normalize("NFKC").toLocaleLowerCase();
    if (
      this.db
        .prepare(
          "SELECT id FROM skills WHERE botId=? AND nameKey=? AND deleted=0 AND id<>?",
        )
        .get(command.botId, nameKey, command.id)
    )
      throw new AppError("conflict", "该 Bot 已有同名技能。");
    const size = z
      .number()
      .parse(
        this.db
          .prepare(
            "SELECT coalesce(sum(length(CAST(body AS BLOB))),0) n FROM skill_versions",
          )
          .get()?.n,
      );
    if (size + Buffer.byteLength(command.body) > 20 * 1024 * 1024)
      throw new AppError("capacity", "技能版本存储达到 20 MiB 上限，未保存。");
    const revision = command.revision + 1;
    if (existing)
      this.db
        .prepare("UPDATE skills SET revision=?,nameKey=? WHERE id=?")
        .run(revision, nameKey, command.id);
    else
      this.db
        .prepare(
          "INSERT INTO skills(id,botId,revision,nameKey) VALUES(?,?,?,?)",
        )
        .run(command.id, command.botId, revision, nameKey);
    this.db
      .prepare("INSERT INTO skill_versions VALUES(?,?,?,?,?,?)")
      .run(
        command.id,
        revision,
        command.name,
        command.description,
        command.body,
        Date.now(),
      );
    return { id: command.id };
  }
  remove(command: z.infer<typeof skillDeleteSchema>) {
    const result = this.db
      .prepare(
        "UPDATE skills SET deleted=1,revision=revision+1 WHERE id=? AND botId=? AND revision=? AND deleted=0",
      )
      .run(command.id, command.botId, command.revision);
    if (!result.changes)
      throw new AppError("conflict", "技能已修改或删除，请重新读取。");
  }
}
