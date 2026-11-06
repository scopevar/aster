import { AppError } from "../shared/core.js";
import {
  groupChoices,
  groupDecisionSchema,
  groupJudgeInstructions,
  type GroupHostState,
  type GroupJudge,
} from "../shared/chat/group-host.js";
import type { StructuredModel } from "../shared/memory.js";
import type { JevClient } from "../agent/jev.js";

/** Broad planning stays with the host. A decision model may handle a narrow routing choice. */
export class HostJudge implements GroupJudge {
  constructor(
    private readonly host: StructuredModel,
    private readonly jev?: JevClient,
  ) {}
  async decide(state: GroupHostState, signal: AbortSignal) {
    const criteria = groupChoices(state);
    if (this.jev) {
      const result = await this.jev.choose(
        state,
        criteria,
        groupJudgeInstructions,
        signal,
      );
      if (result.confidence >= 0.6) return { choice: result.choice };
    }
    const value = await this.host.generate({
      text: JSON.stringify({ state, criteria }),
      instructions: groupJudgeInstructions,
      schema: {
        type: "object",
        properties: { choice: { type: "string", enum: Object.keys(criteria) } },
        required: ["choice"],
        additionalProperties: false,
      },
      signal,
    });
    signal.throwIfAborted();
    const result = groupDecisionSchema.safeParse(value);
    if (!result.success || !Object.hasOwn(criteria, result.data.choice))
      throw new AppError(
        "unavailable",
        "主持人未返回有效的下一步安排，未继续执行成员任务。",
      );
    return result.data;
  }
}
