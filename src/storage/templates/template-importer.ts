import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ValidatedAvatar } from "../../avatars/image.js";
import { defaultAvatar } from "../../shared/avatar.js";
import {
  AppError,
  resultSchema,
  type CommandResult,
} from "../../shared/core.js";
import { type Envelope } from "../../shared/commands.js";
import { templatePayloadSchema } from "../../shared/templates/templates.js";
import type { AvatarStorage } from "../chat/avatars.js";
import type { RoutineService } from "../../routines/service.js";
import type { SkillStorage } from "../tools/skills.js";
import type { TemplateStorage } from "./templates.js";
import type { TemplateToolStorage } from "./template-tools.js";

type Context = {
  fingerprint(body: string): string;
  transaction<T>(fn: () => T): T;
  avatars: AvatarStorage;
  skills: SkillStorage;
  routines: RoutineService;
  templates: TemplateStorage;
  templateTools: TemplateToolStorage;
  enqueueRoutine(
    botId: string,
    text: string,
  ): { id: string; conversationId: string };
  createConversation(botId: string): string;
  changed(): void;
};
export class TemplateImporter {
  constructor(
    private readonly db: DatabaseSync,
    private readonly context: Context,
  ) {}

  templateImportReceipt(envelope: Envelope): CommandResult | undefined {
    if (envelope.command.type !== "template.import")
      throw new AppError("invalid_input", "不是模板导入请求。");
    const row = this.db
      .prepare("SELECT body,result FROM commands WHERE id=?")
      .get(envelope.id);
    if (!row) return undefined;
    if (row.body !== this.context.fingerprint(JSON.stringify(envelope.command)))
      throw new AppError("conflict", "相同命令编号不能用于不同操作。");
    return resultSchema.parse(JSON.parse(z.string().parse(row.result)));
  }

  importTemplate(input: {
    envelope: Envelope;
    avatar: ValidatedAvatar | null;
  }): CommandResult {
    return this.context.transaction(() => {
      const { envelope, avatar } = input;
      const old = this.templateImportReceipt(envelope);
      if (old) return old;
      const command = envelope.command;
      if (command.type !== "template.import")
        throw new AppError("invalid_input", "不是模板导入请求。");
      const payload = templatePayloadSchema.parse(command.payload);
      if (payload.avatar.image && !avatar)
        throw new AppError("invalid_input", "模板头像没有通过内容验证。");
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO bots(id,name,description,tags,language,createdAt) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          payload.name,
          payload.description,
          payload.tags,
          payload.language,
          Date.now(),
        );
      this.db.prepare("UPDATE bots SET avatarJson=? WHERE id=?").run(
        JSON.stringify({
          ...defaultAvatar,
          shape: payload.avatar.shape,
          color: payload.avatar.color,
        }),
        id,
      );
      this.context.avatars.save(
        id,
        0,
        avatar ?? { shape: payload.avatar.shape, color: payload.avatar.color },
      );
      for (const skill of payload.skills)
        this.context.skills.save({
          type: "skill.save",
          id: randomUUID(),
          botId: id,
          revision: 0,
          ...skill,
        });
      for (const routine of payload.routines)
        this.context.routines.execute(
          {
            type: "routine.save",
            id: randomUUID(),
            botId: id,
            revision: 0,
            ...routine,
            enabled: false,
          },
          this.context.enqueueRoutine,
          Date.now(),
        );
      const result = {
        id,
        conversationId: this.context.createConversation(id),
      };
      const imported = this.context.templates.create(payload);
      this.context.templateTools.own(imported.id, id);
      this.db
        .prepare("INSERT INTO commands VALUES(?,?,?)")
        .run(
          envelope.id,
          this.context.fingerprint(JSON.stringify(command)),
          JSON.stringify(result),
        );
      this.context.changed();
      return result;
    });
  }
}
