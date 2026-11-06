import { z } from "zod";
import {
  scriptActionSchema,
  scriptExecutionSchema,
} from "../shared/tools/scripts.js";
import { sandboxNetworkConfigurationSchema } from "../shared/tools/sandbox-settings.js";

export const sandboxLimits = {
  cpus: 1,
  memoryMiB: 512,
  rootMiB: 1024,
  workspaceMiB: 512,
  preparationMs: 600000,
  startupMs: 120000,
  commandMs: 60000,
  outputBytes: 65536,
  stopMs: 10000,
} as const;
export const sandboxPreparationSchema = z
  .object({
    home: z.string().min(1),
    assets: z.string().min(1),
  })
  .strict();
export type SandboxPreparation = z.infer<typeof sandboxPreparationSchema>;
export const sandboxLaunchSchema = sandboxPreparationSchema
  .extend({
    workspace: z.string().min(1),
    inputs: z.string().min(1),
    name: z.string().regex(/^aster-script-[a-f0-9-]{36}$/),
    quotaMiB: z.number().int().min(1).max(sandboxLimits.workspaceMiB),
    network: scriptActionSchema.shape.network,
    configuration: sandboxNetworkConfigurationSchema.optional(),
  })
  .strict();
export type SandboxLaunch = z.infer<typeof sandboxLaunchSchema>;
export const sandboxInputSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("prepare"), config: sandboxPreparationSchema })
    .strict(),
  z.object({ type: z.literal("open"), config: sandboxLaunchSchema }).strict(),
  z
    .object({
      type: z.literal("exec"),
      command: scriptActionSchema.shape.command,
    })
    .strict(),
  z.object({ type: z.literal("close") }).strict(),
]);
export const sandboxOutputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prepared") }).strict(),
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("status"), detail: z.string().max(500) }).strict(),
  z
    .object({ type: z.literal("result"), result: scriptExecutionSchema })
    .strict(),
  z.object({ type: z.literal("error"), detail: z.string().max(1000) }).strict(),
  z.object({ type: z.literal("closed") }).strict(),
]);
