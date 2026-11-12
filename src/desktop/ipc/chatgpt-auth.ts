import { AppError } from "../../shared/core.js";
import {
  chatGPTAuthReplySchema,
  chatGPTAuthStatusSchema,
  type ChatGPTAuthRequest,
} from "../../shared/chatgpt-auth.js";
import { workerRoutes } from "../../shared/protocol.js";
import type { WorkerConnection } from "../worker/worker-connection.js";

/** Only a user-initiated start may open OpenAI's exact authorization endpoint. */
export async function requestChatGPTAuth(
  worker: Pick<WorkerConnection, "call">,
  request: ChatGPTAuthRequest,
  openExternal: (url: string) => Promise<void>,
) {
  const result = chatGPTAuthReplySchema.parse(
    await worker.call(workerRoutes.chatGPTAuth, request),
  );
  if (request.action === "start" && result.authorizationUrl) {
    try {
      const url = new URL(result.authorizationUrl);
      if (
        url.origin !== "https://auth.openai.com" ||
        url.pathname !== "/api/accounts/authorize" ||
        url.username ||
        url.password ||
        url.hash
      )
        throw Error("Invalid authorization URL");
      await openExternal(url.href);
    } catch {
      await worker.call(workerRoutes.chatGPTAuth, {
        action: "cancel",
        id: request.id,
      });
      throw new AppError(
        "unavailable",
        "无法打开 ChatGPT 授权浏览器，请重试。",
      );
    }
  }
  delete result.authorizationUrl;
  return chatGPTAuthStatusSchema.parse(result);
}
