import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  sidebarStateSchema,
  type SectionCommand,
  type SidebarState,
} from "../../shared/chat/sidebar-sections.js";

/** The Store owns this connection and the encompassing command transaction. */
export class SidebarSectionStorage {
  constructor(private readonly db: DatabaseSync) {}

  migrate() {
    this.db.exec(`
      CREATE TABLE sidebar_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, unassignedCollapsed INTEGER NOT NULL DEFAULT 0 CHECK(unassignedCollapsed IN(0,1)));
      INSERT INTO sidebar_state(id) VALUES(1);
      CREATE TABLE sidebar_sections(id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80), position INTEGER NOT NULL, collapsed INTEGER NOT NULL DEFAULT 0 CHECK(collapsed IN(0,1)));
      CREATE INDEX sidebar_section_order ON sidebar_sections(position,id);
      CREATE TABLE sidebar_members(conversationId TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, sectionId TEXT NOT NULL REFERENCES sidebar_sections(id) ON DELETE CASCADE);
      CREATE INDEX sidebar_members_section ON sidebar_members(sectionId);
    `);
  }

  read(): SidebarState {
    const state = z
      .object({ revision: z.number(), unassignedCollapsed: z.number() })
      .parse(
        this.db
          .prepare(
            "SELECT revision,unassignedCollapsed FROM sidebar_state WHERE id=1",
          )
          .get(),
      );
    const members = z
      .array(z.object({ conversationId: z.string(), sectionId: z.string() }))
      .parse(
        this.db
          .prepare(
            "SELECT conversationId,sectionId FROM sidebar_members ORDER BY conversationId",
          )
          .all(),
      );
    return sidebarStateSchema.parse({
      revision: state.revision,
      unassignedCollapsed: state.unassignedCollapsed === 1,
      sections: this.db
        .prepare(
          "SELECT id,name,collapsed FROM sidebar_sections ORDER BY position,id",
        )
        .all()
        .map((row) => ({
          ...row,
          collapsed: row.collapsed === 1,
          conversationIds: members
            .filter((member) => member.sectionId === row.id)
            .map((member) => member.conversationId),
        })),
    });
  }

  private requireSection(id: string) {
    if (!this.db.prepare("SELECT 1 FROM sidebar_sections WHERE id=?").get(id))
      throw new AppError("not_found", "分组已经不存在，请刷新后重试。");
  }

  private requireConversation(id: string) {
    const row = this.db
      .prepare(
        "SELECT c.id FROM conversations c JOIN bots b ON b.id=c.botId WHERE c.id=? AND (b.lifecycle='active' OR EXISTS(SELECT 1 FROM groups g WHERE g.conversationId=c.id)) AND NOT EXISTS(SELECT 1 FROM groups g WHERE g.conversationId=c.id AND g.draft=1)",
      )
      .get(id);
    if (!row) throw new AppError("not_found", "会话已不存在或尚未创建完成。");
    if (
      this.db
        .prepare("SELECT 1 FROM deletion_conversations WHERE conversationId=?")
        .get(id)
    )
      throw new AppError("conflict", "会话正在清理，不能更改分组。");
  }

  execute(command: SectionCommand) {
    const state = this.read();
    if (state.revision !== command.revision)
      throw new AppError("conflict", "分组已在其他操作中更改，请刷新后重试。");
    if (command.type === "section.create") {
      this.requireConversation(command.conversationId);
      if (state.sections.length >= 64)
        throw new AppError(
          "capacity",
          "最多创建 64 个分组，请先整理现有分组。",
        );
      if (state.sections.some((section) => section.id === command.id))
        throw new AppError("conflict", "分组编号已存在。");
      this.db.prepare("UPDATE sidebar_sections SET position=position+1").run();
      this.db
        .prepare("INSERT INTO sidebar_sections(id,name,position) VALUES(?,?,0)")
        .run(command.id, command.name);
      this.assign(command.conversationId, command.id);
    } else if (command.type === "section.assign") {
      this.requireConversation(command.conversationId);
      if (command.id !== null) this.requireSection(command.id);
      this.assign(command.conversationId, command.id);
    } else if (command.type === "section.fold") {
      if (command.id === null)
        this.db
          .prepare("UPDATE sidebar_state SET unassignedCollapsed=? WHERE id=1")
          .run(Number(command.collapsed));
      else {
        this.requireSection(command.id);
        this.db
          .prepare("UPDATE sidebar_sections SET collapsed=? WHERE id=?")
          .run(Number(command.collapsed), command.id);
      }
    } else {
      this.requireSection(command.id);
      if (command.type === "section.rename")
        this.db
          .prepare("UPDATE sidebar_sections SET name=? WHERE id=?")
          .run(command.name, command.id);
      else if (command.type === "section.delete")
        this.db
          .prepare("DELETE FROM sidebar_sections WHERE id=?")
          .run(command.id);
      else {
        if (command.beforeId === command.id)
          throw new AppError("invalid_input", "不能把分组移动到自身之前。");
        if (command.beforeId !== null) this.requireSection(command.beforeId);
        const ids = state.sections
          .map((section) => section.id)
          .filter((id) => id !== command.id);
        ids.splice(
          command.beforeId === null
            ? ids.length
            : ids.indexOf(command.beforeId),
          0,
          command.id,
        );
        const update = this.db.prepare(
          "UPDATE sidebar_sections SET position=? WHERE id=?",
        );
        ids.forEach((id, index) => update.run(index, id));
      }
    }
    this.db
      .prepare("UPDATE sidebar_state SET revision=revision+1 WHERE id=1")
      .run();
  }

  private assign(conversationId: string, sectionId: string | null) {
    if (sectionId === null)
      this.db
        .prepare("DELETE FROM sidebar_members WHERE conversationId=?")
        .run(conversationId);
    else
      this.db
        .prepare(
          "INSERT INTO sidebar_members(conversationId,sectionId) VALUES(?,?) ON CONFLICT(conversationId) DO UPDATE SET sectionId=excluded.sectionId",
        )
        .run(conversationId, sectionId);
  }
}
