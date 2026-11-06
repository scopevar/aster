import { AppError } from "../../shared/core.js";
import { templatePayloadSchema } from "../../shared/templates/templates.js";
import {
  handle,
  type CommandContext,
  type CommandHandlers,
} from "./context.js";

export function captureTemplate(
  ctx: CommandContext,
  botId: string,
  includeSkills: boolean,
  includeRoutines: boolean,
) {
  ctx.requireBot(botId);
  const source = ctx.bots.read(botId, ctx.avatars);
  return templatePayloadSchema.parse({
    format: 1,
    name: source.name,
    description: source.description,
    tags: source.tags,
    language: source.language,
    avatar: {
      shape: source.avatar.shape,
      color: source.avatar.color,
      image: source.avatar.imageHash
        ? ctx.avatars.content({
            botId: source.id,
            hash: source.avatar.imageHash,
          }).data
        : null,
    },
    skills: includeSkills
      ? ctx.skills.list([source.id]).map((ref) => {
          const skill = ctx.skills.content(ref);
          return {
            name: skill.name,
            description: skill.description,
            body: skill.body,
          };
        })
      : [],
    routines: includeRoutines
      ? ctx.routines
          .view({ botId: source.id })
          .routines.filter((routine) => routine.state !== "deleted")
          .map((routine) => ({
            name: routine.name,
            prompt: routine.prompt,
            schedule: routine.schedule,
          }))
      : [],
  });
}

export const templateHandlers = {
  "template.create": handle("template.create", (command, ctx) => {
    const payload = captureTemplate(
      ctx,
      command.botId,
      command.includeSkills,
      command.includeRoutines,
    );
    if (command.includePlugins)
      payload.plugins = ctx.plugins
        .list([command.botId])
        .map(({ name, version }) => ({ name, version }));
    const created = ctx.templates.create(payload);
    ctx.templateTools.own(created.id, command.botId);
    return created;
  }),
  "template.save": handle("template.save", (command, ctx) => {
    if (
      command.payload.avatar.image &&
      (!ctx.validatedAvatar ||
        Buffer.from(ctx.validatedAvatar.bytes).toString("base64") !==
          command.payload.avatar.image)
    )
      throw new AppError("invalid_input", "模板图片必须先完成实际解码验证。");
    return ctx.templates.execute(command);
  }),
  "template.delete": handle("template.delete", (command, ctx) =>
    ctx.templates.execute(command),
  ),
} satisfies Pick<
  CommandHandlers,
  "template.create" | "template.save" | "template.delete"
>;
