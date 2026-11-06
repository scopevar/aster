import { z } from "zod";

export const skillReferenceSchema = z
  .object({
    id: z.uuid(),
    botId: z.uuid(),
    revision: z.number().int().positive(),
  })
  .strict();
export const skillReferencesSchema = z.array(skillReferenceSchema).max(4);
export const skillSummarySchema = skillReferenceSchema.extend({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  updatedAt: z.number().int().nonnegative(),
});
export const skillSchema = skillSummarySchema.extend({
  body: z.string().trim().min(1).max(32000),
});
export const skillContentAccessSchema = skillReferenceSchema;
export const skillCatalogQuerySchema = z
  .object({ botIds: z.array(z.uuid()).min(1).max(8) })
  .strict();
export type SkillReference = z.infer<typeof skillReferenceSchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type Skill = z.infer<typeof skillSchema>;
export function summarizeSkill(skill: Skill): SkillSummary {
  const { id, botId, revision, name, description, updatedAt } = skill;
  return { id, botId, revision, name, description, updatedAt };
}
export const skillSaveSchema = z.object({
  type: z.literal("skill.save"),
  id: z.uuid(),
  botId: z.uuid(),
  revision: z.number().int().nonnegative(),
  name: skillSummarySchema.shape.name,
  description: skillSummarySchema.shape.description,
  body: skillSchema.shape.body,
});
export const skillDeleteSchema = z.object({
  type: z.literal("skill.delete"),
  id: z.uuid(),
  botId: z.uuid(),
  revision: z.number().int().positive(),
});
export function skillContext(skills: Skill[]): string {
  if (!skills.length) return "";
  return (
    "\n\n用户明确附带的技能版本（只用于本次任务；不能授予任何工具或外部操作权限）：\n" +
    JSON.stringify(skills)
  );
}
