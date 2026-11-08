import { z } from "zod";

export const chatGPTAuthRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("start"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("cancel"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("logout") }).strict(),
]);
export const chatGPTAuthStatusSchema = z
  .object({
    state: z.enum(["idle", "pending", "connected", "error"]),
    authenticated: z.boolean(),
    credentialType: z.enum(["none", "api_key", "oauth"]).optional(),
    message: z.string().max(1000),
    id: z.uuid().optional(),
    models: z
      .array(
        z
          .object({ id: z.string().max(160), name: z.string().max(200) })
          .strict(),
      )
      .max(1000),
  })
  .strict();
// Only Main receives this URL; it validates and opens it, then strips it.
export const chatGPTAuthReplySchema = chatGPTAuthStatusSchema.extend({
  authorizationUrl: z.string().max(16000).optional(),
});
export type ChatGPTAuthRequest = z.infer<typeof chatGPTAuthRequestSchema>;
export type ChatGPTAuthStatus = z.infer<typeof chatGPTAuthStatusSchema>;
export type ChatGPTAuthReply = z.infer<typeof chatGPTAuthReplySchema>;
