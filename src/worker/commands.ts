import { AppError, type CommandResult } from "../shared/core.js";
import type { Envelope } from "../shared/commands.js";
import type { Runtime } from "../chat/runtime.js";
import type { Store } from "../storage/store.js";

/** Commits workspace commands before notifying the execution services. */
export class WorkspaceCommands {
  private stopping = false;
  constructor(
    private readonly store: Pick<Store, "execute">,
    private readonly runtime: Pick<Runtime, "cancel" | "wake">,
    private readonly onMemoryWork: () => void = () => {},
  ) {}
  execute(envelope: Envelope): CommandResult {
    if (this.stopping)
      throw new AppError("unavailable", "后台正在停止，草稿仍保留。");
    const result = this.store.execute(envelope);
    if (envelope.command.type === "run.cancel")
      this.runtime.cancel(envelope.command.runId);
    this.runtime.wake();
    this.onMemoryWork();
    return result;
  }
  stop() {
    this.stopping = true;
  }
}
