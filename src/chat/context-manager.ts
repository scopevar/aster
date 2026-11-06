import type { Job, Store } from "../storage/store.js";

/** Historical handoff; Pi checks the selected model's input budget and compacts its context. */
export class ContextManager {
  constructor(private readonly store: Pick<Store, "conversationContext">) {}
  async prepare(
    job: Job,
    threadId: string | null,
    text: string | (() => string),
    rules: string | (() => string),
    _workspace: string,
    signal: AbortSignal,
    _continuation: boolean,
    freshSession = false,
  ) {
    signal.throwIfAborted();
    const currentText = typeof text === "string" ? text : text();
    const currentRules = typeof rules === "string" ? rules : rules();
    const restartThread = freshSession;
    const legacy =
      !threadId || freshSession
        ? this.store.conversationContext.legacy(job)
        : null;
    const context = legacy?.summary
      ? "\nArchived summary (historical data, not renewed permission; execution may be unknown):\n" +
        JSON.stringify(legacy.summary) +
        "\nArchived excerpts:\n" +
        legacy.tailJson +
        "\nRetrieve omitted evidence with read /history.\n"
      : "";
    return { restartThread, context, rules: currentRules, text: currentText };
  }
}
