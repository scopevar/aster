import { z } from "zod";
import { avatarShapes, avatarColors, avatarBase64 } from "../avatar.js";
import { routineScheduleSchema } from "../routines.js";

export const templatePayloadSchema = z
  .object({
    format: z.literal(1),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(4000),
    tags: z.string().max(240),
    language: z.enum(["auto", "zh-CN", "en", "ja"]),
    avatar: z
      .object({
        shape: avatarShapes,
        color: avatarColors,
        image: avatarBase64.nullable(),
      })
      .strict(),
    skills: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            description: z.string().trim().min(1).max(500),
            body: z.string().trim().min(1).max(32000),
          })
          .strict(),
      )
      .max(100),
    plugins: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(100),
            version: z.string().max(100),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    routines: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            prompt: z.string().trim().min(1).max(16000),
            schedule: routineScheduleSchema,
          })
          .strict(),
      )
      .max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    const names = value.skills.map((skill) =>
      skill.name.normalize("NFKC").toLocaleLowerCase(),
    );
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: "custom", message: "模板技能名称不能重复" });
    if (
      new TextEncoder().encode(JSON.stringify(value)).length >
      2 * 1024 * 1024
    )
      ctx.addIssue({ code: "custom", message: "模板内容超过 2 MiB" });
  });
export type TemplatePayload = z.infer<typeof templatePayloadSchema>;

export const templateCommandSchemas = [
  z
    .object({
      type: z.literal("template.create"),
      botId: z.uuid(),
      includeSkills: z.boolean(),
      includeRoutines: z.boolean(),
      includePlugins: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("template.save"),
      id: z.uuid(),
      revision: z.number().int().positive(),
      payload: templatePayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("template.delete"),
      id: z.uuid(),
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("template.import"),
      payload: templatePayloadSchema,
    })
    .strict(),
] as const;
export const templateCommandSchema = z.discriminatedUnion(
  "type",
  templateCommandSchemas,
);
export type TemplateCommand = z.infer<typeof templateCommandSchema>;
export const templateDraftSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  payload: templatePayloadSchema,
  updatedAt: z.number(),
});
export type TemplateDraft = z.infer<typeof templateDraftSchema>;
export const localTemplatesSchema = z.object({
  drafts: z
    .array(
      templateDraftSchema
        .omit({ payload: true })
        .extend({ name: z.string(), description: z.string() }),
    )
    .max(100),
});
export type LocalTemplates = z.infer<typeof localTemplatesSchema>;
export const templateSelectionSchema = z
  .object({
    configuration: z.boolean(),
    skills: z.array(z.number().int().nonnegative()).max(100),
    routines: z.array(z.number().int().nonnegative()).max(64),
    plugins: z.array(z.number().int().nonnegative()).max(100),
  })
  .strict();
export const templatesQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z.object({ kind: z.literal("draft"), id: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("export"),
      id: z.uuid(),
      revision: z.number().int().positive(),
      selection: templateSelectionSchema,
    })
    .strict(),
]);
export const templatesResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), data: localTemplatesSchema }),
  z.object({ kind: z.literal("draft"), data: templateDraftSchema }),
  z.object({ kind: z.literal("export"), data: templatePayloadSchema }),
]);
export const templateFileRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open") }).strict(),
  z
    .object({
      action: z.literal("save"),
      id: z.uuid(),
      revision: z.number().int().positive(),
      selection: templateSelectionSchema,
    })
    .strict(),
]);
export const templateFileResultSchema = z
  .object({ cancelled: z.boolean(), payload: templatePayloadSchema.nullable() })
  .strict();
export type TemplateFileRequest = z.infer<typeof templateFileRequestSchema>;
export type TemplateFileResult = z.infer<typeof templateFileResultSchema>;
export type TemplatesQuery = z.infer<typeof templatesQuerySchema>;
export type TemplatesResponse = z.infer<typeof templatesResponseSchema>;
