import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AppError } from "../../shared/core.js";
import { runStatusSchema } from "../../shared/chat/runs.js";
import type { GroupStorage } from "../chat/groups.js";
import type { QuestionStorage } from "../tools/questions.js";

/** Used inside the owner's transaction for user cancellation and runtime deadlines. */
export function cancelRun(
  db: DatabaseSync,
  context: { groups: GroupStorage; questions: QuestionStorage },
  id: string,
  detail: string | null = null,
) {
  const row = db.prepare("SELECT status FROM runs WHERE id=?").get(id);
  if (!row) throw new AppError("not_found", "任务已不存在。");
  const { status } = z.object({ status: runStatusSchema }).parse(row);
  if (["queued", "running", "cancelling"].includes(status))
    context.questions.cancelRun(id);
  context.groups.cancel(id);
  if (["queued", "running", "cancelling"].includes(status))
    db.prepare(
      "UPDATE runs SET status=?,error=coalesce(?,error) WHERE id=?",
    ).run(status === "queued" ? "cancelled" : "cancelling", detail, id);
}
