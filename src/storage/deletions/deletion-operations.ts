import type { DeletionStorage } from "./deletions.js";
type Context = {
  deletions: DeletionStorage;
  transaction<T>(fn: () => T): T;
  changed(): void;
};
/** Domain coordination uses the Store owner's synchronous transaction. */
export class DeletionOperations {
  constructor(private readonly context: Context) {}
  deletionNext() {
    return this.context.deletions.next();
  }
  deletionRunIds(id: string) {
    return this.context.deletions.runIds(id);
  }
  deletionStart(id: string) {
    this.context.transaction(() => {
      this.context.deletions.start(id);
      this.context.changed();
    });
  }
  deletionPlan(id: string) {
    return this.context.transaction(() => this.context.deletions.plan(id));
  }
  deletionComplete(id: string) {
    this.context.transaction(() => {
      this.context.deletions.complete(id);
      this.context.changed();
    });
  }
  deletionFail(id: string, detail: string, paused = false) {
    this.context.transaction(() => {
      this.context.deletions.fail(id, detail, paused);
      this.context.changed();
    });
  }
}
