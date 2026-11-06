import type {
  MemoryJobStatus,
  MemoryProposal,
  MemoryScope,
  MemoryWork,
  SharedMemoryScope,
} from "../../shared/memory.js";
import type { DeletionStorage } from "../deletions/deletions.js";
import type { Job } from "../job.js";
import type { MemoryJobStorage } from "./memory-jobs.js";
import type { MemoryStorage } from "./memory.js";
import type { SharedMemoryStorage } from "./shared-memory.js";
type Context = {
  memory: MemoryStorage;
  memoryJobs: MemoryJobStorage;
  sharedMemory: SharedMemoryStorage;
  deletions: DeletionStorage;
  transaction<T>(fn: () => T): T;
  changed(): void;
};
/** Domain coordination uses the Store owner's synchronous transaction. */
export class MemoryOperations {
  constructor(private readonly context: Context) {}
  memoryView(scope: MemoryScope) {
    this.context.deletions.botActive(scope.botId);
    if (scope.conversationId)
      this.context.deletions.conversationAvailable(scope.conversationId);
    return this.context.memory.view(scope);
  }
  sharedMemoryView(scope: SharedMemoryScope) {
    return this.context.sharedMemory.view(scope);
  }
  memoryClaim() {
    return this.context.transaction(() => {
      const work = this.context.memoryJobs.claim();
      if (work) this.context.changed();
      return work;
    });
  }
  memoryActive(work: MemoryWork) {
    return this.context.memoryJobs.active(work);
  }
  memoryVerify(work: MemoryWork) {
    this.context.transaction(() => {
      this.context.memoryJobs.verifying(work);
      this.context.changed();
    });
  }
  memoryApply(work: MemoryWork, proposal: MemoryProposal) {
    this.context.transaction(() => {
      this.context.memoryJobs.apply(work, proposal);
      this.context.changed();
    });
  }
  memoryEnd(work: MemoryWork, status: MemoryJobStatus, error: string | null) {
    this.context.transaction(() => {
      this.context.memoryJobs.end(work, status, error);
      this.context.changed();
    });
  }
  memoryContext(job: Job) {
    return (
      this.context.memory.context({
        botId: job.botId,
        conversationId:
          job.groupOrdinal === undefined ? null : job.conversationId,
      }) + this.context.sharedMemory.context()
    );
  }
}
