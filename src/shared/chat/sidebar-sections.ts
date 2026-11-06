import { z } from "zod";

const revision = z.number().int().nonnegative();
const name = z.string().trim().min(1).max(80);
export const sidebarSectionSchema = z.object({
  id: z.uuid(),
  name,
  collapsed: z.boolean(),
  conversationIds: z.array(z.uuid()),
});
export const sidebarStateSchema = z.object({
  revision,
  unassignedCollapsed: z.boolean(),
  sections: z.array(sidebarSectionSchema).max(64),
});
export type SidebarState = z.infer<typeof sidebarStateSchema>;
export type SidebarSection = z.infer<typeof sidebarSectionSchema>;
export const sectionCommandSchemas = [
  z
    .object({
      type: z.literal("section.create"),
      revision,
      id: z.uuid(),
      name,
      conversationId: z.uuid(),
    })
    .strict(),
  z
    .object({ type: z.literal("section.rename"), revision, id: z.uuid(), name })
    .strict(),
  z
    .object({
      type: z.literal("section.assign"),
      revision,
      id: z.uuid().nullable(),
      conversationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("section.fold"),
      revision,
      id: z.uuid().nullable(),
      collapsed: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("section.move"),
      revision,
      id: z.uuid(),
      beforeId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({ type: z.literal("section.delete"), revision, id: z.uuid() })
    .strict(),
] as const;
export const sectionCommandSchema = z.discriminatedUnion(
  "type",
  sectionCommandSchemas,
);
export type SectionCommand = z.infer<typeof sectionCommandSchema>;
