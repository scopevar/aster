import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import {
  installedPluginSchema,
  pluginContentSchema,
  pluginVariablesSchema,
  type PluginContent,
  type InstalledPlugin,
} from "../../shared/tools/plugins.js";
import type { SkillStorage } from "./skills.js";

const storedSchema = z.object({
  id: z.uuid(),
  botId: z.uuid(),
  content: pluginContentSchema,
  enabled: z.number().int().min(0).max(1),
  variables: pluginVariablesSchema,
  installedAt: z.number().int(),
  skillIds: z.array(z.object({ id: z.uuid(), revision: z.number().int() })),
});

export class PluginStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly skills: Pick<SkillStorage, "save" | "remove">,
    private readonly owner: {
      transaction<T>(fn: () => T): T;
      requireBot(id: string): void;
    },
  ) {}

  migrate() {
    this.db.exec(`
      CREATE TABLE plugins(
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        contentJson TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        variablesJson TEXT NOT NULL DEFAULT '{}',
        installedAt INTEGER NOT NULL,
        skillIdsJson TEXT NOT NULL DEFAULT '[]'
      );
      CREATE UNIQUE INDEX plugins_bot_name ON plugins(botId,name);
    `);
  }

  private row(id: string, botId: string) {
    const row = this.db
      .prepare("SELECT * FROM plugins WHERE id=? AND botId=?")
      .get(id, botId);
    if (!row) throw new AppError("not_found", "插件不存在或不属于该 Bot。");
    return storedSchema.parse({
      id: row.id,
      botId: row.botId,
      content: JSON.parse(z.string().parse(row.contentJson)),
      enabled: row.enabled,
      variables: JSON.parse(z.string().parse(row.variablesJson)),
      installedAt: row.installedAt,
      skillIds: JSON.parse(z.string().parse(row.skillIdsJson)),
    });
  }

  list(botId: string[]) {
    for (const id of botId) this.owner.requireBot(id);
    return botId.flatMap((owner) =>
      this.db
        .prepare("SELECT * FROM plugins WHERE botId=? ORDER BY installedAt,id")
        .all(owner)
        .map((row) => {
          const value = storedSchema.parse({
            id: row.id,
            botId: row.botId,
            content: JSON.parse(z.string().parse(row.contentJson)),
            enabled: row.enabled,
            variables: JSON.parse(z.string().parse(row.variablesJson)),
            installedAt: row.installedAt,
            skillIds: JSON.parse(z.string().parse(row.skillIdsJson)),
          });
          const preview: InstalledPlugin = {
            id: value.id,
            botId: value.botId,
            name: value.content.name,
            description: value.content.description,
            version: value.content.version,
            format: value.content.format,
            variables: value.content.variables,
            warnings: value.content.warnings,
            enabled: value.enabled === 1,
            installedAt: value.installedAt,
            skills: value.content.skills.map(({ name, description }) => ({
              name,
              description,
            })),
            servers: Object.entries(value.content.servers).map(
              ([name, server]) => ({
                name,
                transport: "command" in server ? "stdio" : server.type,
                target: "command" in server ? server.command : server.url,
              }),
            ),
          };
          return installedPluginSchema.parse(preview);
        }),
    );
  }

  install(
    botId: string,
    id: string,
    content: PluginContent,
    variables: Record<string, string>,
    enableTools: boolean,
  ) {
    this.owner.requireBot(botId);
    content = pluginContentSchema.parse(content);
    variables = pluginVariablesSchema.parse(variables);
    if (enableTools && content.variables.some((name) => !variables[name]))
      throw new AppError("invalid_input", "启用 MCP 前请填写全部所需变量。");
    return this.owner.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT id,contentJson,variablesJson,enabled FROM plugins WHERE botId=? AND (id=? OR name=?)",
        )
        .get(botId, id, content.name);
      if (existing) {
        if (
          existing.id === id &&
          existing.contentJson === JSON.stringify(content) &&
          existing.variablesJson === JSON.stringify(variables) &&
          existing.enabled === (enableTools ? 1 : 0)
        )
          return this.get(botId, id);
        throw new AppError("conflict", "该 Bot 已安装同名或同 ID 插件。");
      }
      const capacity = z
        .number()
        .parse(
          this.db
            .prepare("SELECT count(*) n FROM plugins WHERE botId=?")
            .get(botId)?.n,
        );
      if (capacity >= 16)
        throw new AppError("capacity", "每个 Bot 最多 16 个插件。");
      const total = z
        .number()
        .parse(
          this.db
            .prepare(
              "SELECT coalesce(sum(length(CAST(contentJson AS BLOB))),0) n FROM plugins",
            )
            .get()?.n,
        );
      if (total + Buffer.byteLength(JSON.stringify(content)) > 64 * 1024 * 1024)
        throw new AppError("capacity", "插件快照存储达到 64 MiB 上限。");
      const skillIds: Array<{ id: string; revision: number }> = [];
      for (const skill of content.skills) {
        const skillId = randomUUID();
        this.skills.save({
          type: "skill.save",
          id: skillId,
          botId,
          revision: 0,
          name: skill.name,
          description: skill.description,
          body: skill.body,
        });
        skillIds.push({ id: skillId, revision: 1 });
      }
      this.db
        .prepare(
          "INSERT INTO plugins(id,botId,name,contentJson,enabled,variablesJson,installedAt,skillIdsJson) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          botId,
          content.name,
          JSON.stringify(content),
          enableTools ? 1 : 0,
          JSON.stringify(pluginVariablesSchema.parse(variables)),
          Date.now(),
          JSON.stringify(skillIds),
        );
      return this.get(botId, id);
    });
  }

  execution(botId: string, id: string) {
    this.owner.requireBot(botId);
    const value = this.row(id, botId);
    if (!value.enabled)
      throw new AppError("unauthorized", "插件 MCP 尚未启用。");
    return value;
  }

  get(botId: string, id: string) {
    this.row(id, botId);
    return (
      this.list([botId]).find((item) => item.id === id) ??
      (() => {
        throw new AppError("not_found", "插件不存在。");
      })()
    );
  }

  configure(
    botId: string,
    id: string,
    enabled: boolean,
    variables?: Record<string, string>,
  ) {
    this.owner.requireBot(botId);
    return this.owner.transaction(() => {
      const value = this.row(id, botId);
      const nextVariables = pluginVariablesSchema.parse(
        variables ?? value.variables,
      );
      if (
        enabled &&
        value.content.variables.some((name) => !nextVariables[name])
      )
        throw new AppError("invalid_input", "启用 MCP 前请填写全部所需变量。");
      this.db
        .prepare(
          "UPDATE plugins SET enabled=?,variablesJson=? WHERE id=? AND botId=?",
        )
        .run(enabled ? 1 : 0, JSON.stringify(nextVariables), id, botId);
      if (
        !enabled ||
        JSON.stringify(nextVariables) !== JSON.stringify(value.variables)
      )
        this.db
          .prepare(
            "UPDATE plugin_calls SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'cancelled' END,detail='插件权限或配置已变更。' WHERE pluginId=? AND status IN ('pending','approved','running')",
          )
          .run(id);
      return this.get(botId, id);
    });
  }

  remove(botId: string, id: string) {
    this.owner.requireBot(botId);
    return this.owner.transaction(() => {
      const value = this.row(id, botId);
      for (const skill of value.skillIds) {
        try {
          this.skills.remove({
            type: "skill.delete",
            id: skill.id,
            botId,
            revision: skill.revision,
          });
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "conflict")
            throw error;
        }
      }
      this.db
        .prepare(
          "UPDATE plugin_calls SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'cancelled' END,detail='插件已卸载。' WHERE pluginId=? AND status IN ('pending','approved','running')",
        )
        .run(id);
      this.db
        .prepare("DELETE FROM plugins WHERE id=? AND botId=?")
        .run(id, botId);
    });
  }
}
