import { z } from "zod";

export const updatePreparationRequestSchema = z
  .object({
    action: z.enum(["begin", "poll", "cancel", "stop"]),
    id: z.uuid(),
  })
  .strict();
export const updatePreparationStateSchema = z
  .object({
    ready: z.boolean(),
    waiting: z.array(z.string().max(80)).max(8),
  })
  .strict();
export const UPDATE_PREPARING =
  "正在准备更新，暂不接收新工作。可取消更新后继续。";
