import type { RoutineQuery, WebhookInput } from "../shared/routines.js";
import type { Job } from "../storage/job.js";
import type { RoutineService } from "./service.js";
type Context = {
  routines: RoutineService;
  transaction<T>(fn: () => T): T;
  changed(): void;
  requireBot(id: string): void;
  createConversation(botId: string, hidden?: boolean): string;
  enqueueMessage(conversationId: string, text: string): { id: string };
};
/** Scheduling and webhook admission share the command transaction and enqueue path. */
export class RoutineOperations {
  constructor(private readonly context: Context) {}
  view(query: RoutineQuery) {
    return this.context.routines.view(query);
  }
  routineContext(job: Job) {
    if (job.groupOrdinal !== undefined || this.context.routines.isRun(job.id))
      return "";
    return this.context.routines.context(job.botId);
  }
  isRun(runId: string) {
    return this.context.routines.isRun(runId);
  }
  enqueue = (botId: string, text: string) => {
    this.context.requireBot(botId);
    const conversationId = this.context.createConversation(botId, true);
    return {
      ...this.context.enqueueMessage(conversationId, text),
      conversationId,
    };
  };
  tick(now = Date.now()) {
    return this.context.transaction(() => {
      const count = this.context.routines.tick(now, this.enqueue);
      if (count) this.context.changed();
      return count;
    });
  }
  acceptWebhook(
    id: string,
    token: string,
    input: WebhookInput,
    now = Date.now(),
  ) {
    return this.context.transaction(() => {
      const result = this.context.routines.webhook(
        id,
        token,
        input,
        now,
        this.enqueue,
      );
      this.context.changed();
      return this.context.routines.event(result.id, id);
    });
  }
  webhookEvent(routineId: string, token: string, eventId: string) {
    this.context.routines.authenticate(routineId, token);
    return this.context.routines.event(eventId, routineId);
  }
}
