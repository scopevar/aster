import { AppError } from "../shared/core.js";
import type { Agent } from "../chat/agent.js";
import type { Runtime } from "../chat/runtime.js";
import type { MemoryService } from "../memory/service.js";
import type { Store } from "../storage/store.js";
import { cleanWindowsFiles, ownedWorkspace } from "./files.js";

/** This is the only deletion executor. Store owns admission, revocation and the durable plan. */
export class DeletionService {
  private loop: Promise<void> | undefined;
  private requested = false;
  private stopping = false;
  private updatePaused = false;
  private readonly shutdown = new AbortController();
  constructor(
    private readonly store: Pick<Store, "deletionOperations">,
    private readonly runtime: Pick<Runtime, "quiesce">,
    private readonly memory: Pick<MemoryService, "quiesce">,
    private readonly workspaces: string,
    private readonly cleanup?: Agent["cleanThreads"],
    private readonly cleanupPluginAuth?: (botId: string) => Promise<void>,
  ) {}
  pauseForUpdate(paused: boolean) {
    this.updatePaused = paused;
    if (!paused) this.wake();
  }
  get updateBusy() {
    return Number(this.loop !== undefined);
  }
  wake() {
    this.requested = true;
    if (this.loop || this.stopping) return;
    this.requested = false;
    this.loop = this.pump()
      .catch((error: unknown) => {
        this.stopping = true;
        console.error(
          "deletion lane halted",
          error instanceof Error ? error.name : "Error",
        );
      })
      .finally(() => {
        this.loop = undefined;
        if (this.requested && !this.stopping) this.wake();
      });
  }
  private async pump() {
    while (!this.stopping && !this.updatePaused) {
      const job = this.store.deletionOperations.deletionNext();
      if (!job) return;
      this.store.deletionOperations.deletionStart(job.id);
      const signal = AbortSignal.any([
        this.shutdown.signal,
        AbortSignal.timeout(120000),
      ]);
      try {
        await waitOwned(
          Promise.all([
            this.runtime.quiesce(
              this.store.deletionOperations.deletionRunIds(job.id),
            ),
            this.memory.quiesce(job.kind, job.targetId),
          ]),
          signal,
        );
        signal.throwIfAborted();
        const plan = this.store.deletionOperations.deletionPlan(job.id);
        if (plan.botId) await this.cleanupPluginAuth?.(plan.botId);
        for (const scope of plan.threads) {
          const workspace = await ownedWorkspace(
            this.workspaces,
            scope.botId,
            true,
          );
          if (!workspace) throw Error("owned workspace unavailable");
          if (this.cleanup)
            await this.cleanup(
              workspace,
              scope.all ? undefined : scope.ids,
              signal,
              scope.ids,
            );
          else if (scope.ids.length)
            throw new AppError(
              "unavailable",
              "当前 Agent 不支持会话清理，已保留删除记录。",
            );
        }
        signal.throwIfAborted();
        await cleanWindowsFiles(this.workspaces, plan, signal);
        signal.throwIfAborted();
        this.store.deletionOperations.deletionComplete(job.id);
      } catch (error) {
        this.store.deletionOperations.deletionFail(
          job.id,
          this.stopping
            ? "后台主动停止，清理将在下次启动核实后继续。"
            : signal.aborted
              ? "清理超过两分钟，尚未确认全部完成；已保留清理记录，请重试核实。"
              : error instanceof Error
                ? error.message
                : "清理失败，请保留记录并重试。",
          this.stopping,
        );
      }
    }
  }
  async stop() {
    this.stopping = true;
    this.shutdown.abort();
    await this.loop;
  }
}

/** Waiting may time out; the original services still own and observe their work. */
function waitOwned<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
