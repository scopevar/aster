import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/core.js";
import { botSchema } from "../../shared/chat/bots.js";
import { defaultAvatar } from "../../shared/avatar.js";
import type { CommandContext } from "../commands/context.js";
import type { Command } from "../../shared/commands.js";
type BotCommandContext = Pick<
  CommandContext,
  | "avatars"
  | "skills"
  | "routines"
  | "validatedAvatar"
  | "requireBot"
  | "createConversation"
  | "enqueueRoutine"
>;

export class BotStorage {
  constructor(private readonly db: DatabaseSync) {}

  lifecycle(id: string) {
    return this.db.prepare("SELECT lifecycle FROM bots WHERE id=?").get(id)
      ?.lifecycle;
  }
  require(id: string) {
    if (!this.db.prepare("SELECT id FROM bots WHERE id=?").get(id))
      throw new AppError("not_found", "Bot 已不存在。");
  }
  read(botId: string, avatars: BotCommandContext["avatars"]) {
    return botSchema.parse({
      ...this.db.prepare("SELECT * FROM bots WHERE id=?").get(botId),
      avatar: avatars.read(botId),
    });
  }

  create(
    command: Extract<Command, { type: "bot.create" }>,
    ctx: BotCommandContext,
  ) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO bots(id,name,description,createdAt) VALUES(?,?,?,?)",
      )
      .run(id, command.name, command.description, Date.now());
    this.db
      .prepare("UPDATE bots SET avatarJson=? WHERE id=?")
      .run(JSON.stringify(defaultAvatar), id);
    return { id, conversationId: ctx.createConversation(id) };
  }
  update(
    command: Extract<Command, { type: "bot.update" }>,
    ctx: BotCommandContext,
  ) {
    ctx.requireBot(command.botId);
    this.db
      .prepare("UPDATE bots SET name=?,description=? WHERE id=?")
      .run(command.name, command.description, command.botId);
    return {};
  }
  preferences(
    command: Extract<Command, { type: "bot.preferences" }>,
    ctx: BotCommandContext,
  ) {
    ctx.requireBot(command.botId);
    this.db
      .prepare(
        "UPDATE bots SET name=?,description=?,tags=?,language=? WHERE id=?",
      )
      .run(
        command.name,
        command.description,
        command.tags,
        command.language,
        command.botId,
      );
    return {};
  }
  copy(
    command: Extract<Command, { type: "bot.copy" }>,
    ctx: BotCommandContext,
  ) {
    ctx.requireBot(command.botId);
    const source = botSchema.parse({
      ...this.db.prepare("SELECT * FROM bots WHERE id=?").get(command.botId),
      avatar: ctx.avatars.read(command.botId),
    });
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO bots(id,name,description,tags,language,createdAt) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        command.name,
        source.description,
        source.tags,
        source.language,
        Date.now(),
      );
    ctx.avatars.copy(command.botId, id);
    if (command.includeSkills) {
      for (const ref of ctx.skills.list([command.botId])) {
        const skill = ctx.skills.content(ref);
        ctx.skills.save({
          type: "skill.save",
          botId: id,
          id: randomUUID(),
          revision: 0,
          name: skill.name,
          description: skill.description,
          body: skill.body,
        });
      }
    }
    if (command.includeRoutines) {
      for (const routine of ctx.routines
        .view({ botId: command.botId })
        .routines.filter((item) => item.state !== "deleted")) {
        ctx.routines.execute(
          {
            type: "routine.save",
            id: randomUUID(),
            botId: id,
            revision: 0,
            name: routine.name,
            prompt: routine.prompt,
            schedule: routine.schedule,
            enabled: false,
          },
          ctx.enqueueRoutine,
          Date.now(),
        );
      }
    }
    return { id, conversationId: ctx.createConversation(id) };
  }
  saveCharacter(
    command: Extract<Command, { type: "bot.avatar.character" }>,
    ctx: BotCommandContext,
  ) {
    ctx.avatars.save(command.botId, command.revision, command);
    return {};
  }
  saveImage(
    command: Extract<Command, { type: "bot.avatar.image" }>,
    ctx: BotCommandContext,
  ) {
    if (
      !ctx.validatedAvatar ||
      Buffer.from(ctx.validatedAvatar.bytes).toString("base64") !== command.data
    )
      throw new AppError("invalid_input", "头像尚未经过完整解码验证。");
    ctx.avatars.save(command.botId, command.revision, ctx.validatedAvatar);
    return {};
  }
}
