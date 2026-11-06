import { ValidatedAvatar } from "./image.js";
import { AppError, type CommandResult } from "../shared/core.js";
import type { Envelope } from "../shared/commands.js";
import type { Store } from "../storage/store.js";

/** Image decoding is asynchronous; the accepted write still uses Store's transaction. */
export class AvatarCommands {
  private stopping = false;
  constructor(
    private readonly store: Pick<Store, "execute" | "templateImporter">,
  ) {}
  private readonly imageJobs = new Set<Promise<CommandResult>>();
  save(envelope: Envelope): Promise<CommandResult> {
    if (this.stopping)
      return Promise.reject(
        new AppError("unavailable", "后台正在停止，头像未接受。"),
      );
    if (this.imageJobs.size >= 2)
      return Promise.reject(
        new AppError("capacity", "正在处理其他图片，请稍后重试。"),
      );
    const command = envelope.command;
    const data =
      command.type === "bot.avatar.image"
        ? command.data
        : command.type === "template.save" || command.type === "template.import"
          ? command.payload.avatar.image
          : null;
    if (!data && command.type !== "template.import")
      return Promise.reject(
        new AppError("invalid_input", "不是头像图片请求。"),
      );
    const task = (
      data ? ValidatedAvatar.decode(data) : Promise.resolve(null)
    ).then((image) => {
      if (this.stopping)
        throw new AppError("unavailable", "后台正在停止，头像未保存。");
      return command.type === "template.import"
        ? this.store.templateImporter.importTemplate({
            envelope,
            avatar: image,
          })
        : this.store.execute(envelope, image ?? undefined);
    });
    this.imageJobs.add(task);
    return task.finally(() => this.imageJobs.delete(task));
  }

  async stop() {
    this.stopping = true;
    await Promise.allSettled([...this.imageJobs]);
  }
}
