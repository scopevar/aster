import type { Runtime } from "../chat/runtime.js";
import type { Store } from "../storage/store.js";

/** One timer owned by the worker. Durable cursors survive sleep; there is no in-memory job queue. */
export class RoutineScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  error: string | null = null;
  constructor(
    private readonly store: Pick<Store, "routineOperations">,
    private readonly runtime: Runtime,
  ) {}
  pauseForUpdate(paused: boolean) {
    if (paused) {
      clearTimeout(this.timer);
      this.timer = undefined;
    } else this.start();
  }
  start() {
    if (this.timer || this.stopped) return;
    this.tick();
  }
  private tick = () => {
    if (this.stopped) return;
    let delay = 1000;
    try {
      if (this.store.routineOperations.tick()) this.runtime.wake();
      this.error = null;
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : "例行任务调度失败。";
      // Leave all cursors unchanged on failure. Back off and expose the failure in the management view.
      delay = 30000;
      console.error(
        "routine scheduler failed",
        error instanceof Error ? error.name : "Error",
      );
    }
    this.timer = setTimeout(this.tick, delay);
  };
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
