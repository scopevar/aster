import type { DesktopEnvelope as Envelope } from "../../shared/desktop/desktop-commands.js";
import type { DesktopCommand as Command } from "../../shared/desktop/desktop-commands.js";
import type { CommandResult } from "../../shared/core.js";

type Pending = {
  command: Command;
  request: Envelope | undefined;
  finish: Array<{
    resolve(value: CommandResult): void;
    reject(error: unknown): void;
  }>;
};

/** Coalesces only unsent adjacent drafts; every other command is an ordering barrier. */
export class CommandQueue {
  private pending: Pending[] = [];
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly send: (
      command: Command,
      request?: Envelope,
    ) => Promise<CommandResult>,
  ) {}

  submit(command: Command, request?: Envelope): Promise<CommandResult> {
    const task = new Promise<CommandResult>((resolve, reject) => {
      const previous = this.pending.at(-1);
      if (
        !request &&
        command.type === "draft.save" &&
        !previous?.request &&
        previous?.command.type === "draft.save" &&
        previous.command.conversationId === command.conversationId
      ) {
        previous.command = command;
        previous.finish.push({ resolve, reject });
      } else
        this.pending.push({ command, request, finish: [{ resolve, reject }] });
    });
    if (command.type !== "draft.save" || request) this.flush();
    else if (!this.running && !this.timer)
      this.timer = setTimeout(() => this.flush(), 200);
    return task;
  }

  /** Flush on navigation/unmount so accepted drafts do not remain on a timer. */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running) void this.pump();
  }
  private async pump() {
    this.running = true;
    try {
      for (;;) {
        const next = this.pending.shift();
        if (!next) return;
        try {
          const result = await this.send(next.command, next.request);
          for (const waiter of next.finish) waiter.resolve(result);
        } catch (error) {
          for (const waiter of next.finish) waiter.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
