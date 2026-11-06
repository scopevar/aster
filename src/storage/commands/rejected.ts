import { AppError } from "../../shared/core.js";
import { handle, type CommandHandlers } from "./context.js";

function refuse(type: "template.import" | "agent.check" | "worker.stop") {
  return handle(type, () => {
    throw new AppError("invalid_input", "该命令不属于存储接口。");
  });
}

/** These commands are accepted by the worker, not by the storage transaction. */
export const rejectedHandlers = {
  "template.import": refuse("template.import"),
  "agent.check": refuse("agent.check"),
  "worker.stop": refuse("worker.stop"),
} satisfies Pick<
  CommandHandlers,
  "template.import" | "agent.check" | "worker.stop"
>;
