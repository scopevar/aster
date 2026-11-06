import { AppError } from "../shared/core.js";
import { UPDATE_PREPARING } from "../shared/update-preparation.js";
import type { Command } from "../shared/commands.js";

/** The controller renews this hold while waiting; losing it must not leave a daemon paused. */
export class UpdatePreparation {
  private owner: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly session: {
      runtime: Pausable;
      memory: Pausable;
      deletions: Pausable;
      scheduler: { pauseForUpdate(paused: boolean): void };
      requests: { readonly count: number };
      avatars: { readonly updateBusy: number };
    },
  ) {}
  get active() {
    return this.owner !== undefined;
  }
  command(command: Command) {
    if (
      this.active &&
      ![
        "run.cancel",
        "question.answer",
        "tool.decide",
        "draft.save",
        "reply.save",
        "conversation.read",
        "conversation.unread",
        "reaction.set",
        "worker.stop",
      ].includes(command.type)
    )
      throw new AppError("unavailable", UPDATE_PREPARING);
  }
  request(action: "begin" | "poll" | "cancel" | "stop", id: string) {
    if (action === "cancel") {
      if (this.owner === id) this.release();
      return this.status();
    }
    if (this.owner && this.owner !== id)
      throw new AppError("conflict", "已有控制端正在准备更新。");
    if ((action === "poll" || action === "stop") && this.owner !== id)
      throw new AppError("unavailable", "更新等待已结束，请重新安装。");
    this.owner = id;
    this.pause(true);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.release(), 15_000);
    return this.status();
  }
  private status() {
    const s = this.session;
    const waiting = [
      s.runtime.updateBusy ? `${s.runtime.updateBusy} 个会话或后台任务` : "",
      s.memory.updateBusy ? "记忆提炼" : "",
      s.deletions.updateBusy ? "删除清理" : "",
      s.avatars.updateBusy ? "图片处理" : "",
      s.requests.count ? "已接收的文件或服务请求" : "",
    ].filter(Boolean);
    return { ready: waiting.length === 0, waiting };
  }
  private pause(paused: boolean) {
    const s = this.session;
    s.runtime.pauseForUpdate(paused);
    s.memory.pauseForUpdate(paused);
    s.deletions.pauseForUpdate(paused);
    s.scheduler.pauseForUpdate(paused);
  }
  private release() {
    this.close();
    this.pause(false);
  }
  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.owner = undefined;
  }
}

type Pausable = {
  pauseForUpdate(paused: boolean): void;
  readonly updateBusy: number;
};
