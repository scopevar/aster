import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  avatarSchema,
  type AvatarStyle,
  type AvatarAccess,
} from "../../shared/avatar.js";
import { AppError } from "../../shared/core.js";
import type { ValidatedAvatar } from "../../avatars/image.js";
import { z } from "zod";

/** Shares Store's connection and transaction; image bytes and identity change together. */
export class AvatarStorage {
  constructor(private readonly db: DatabaseSync) {}
  migrate() {
    this.db
      .exec(`ALTER TABLE bots ADD COLUMN avatarJson TEXT NOT NULL DEFAULT '{"shape":"blob","color":"black","revision":0,"imageHash":null}';
 CREATE TABLE bot_avatar_images(botId TEXT PRIMARY KEY REFERENCES bots(id),data BLOB NOT NULL CHECK(length(data)<=65536));`);
  }
  read(botId: string): AvatarStyle {
    const row = this.db
      .prepare("SELECT avatarJson FROM bots WHERE id=?")
      .get(botId);
    if (!row) throw new AppError("not_found", "Bot 不存在。");
    return avatarSchema.parse(JSON.parse(z.string().parse(row.avatarJson)));
  }
  copy(sourceId: string, targetId: string) {
    const source = this.read(sourceId);
    if (source.imageHash) {
      const content = this.content({ botId: sourceId, hash: source.imageHash });
      this.db
        .prepare("INSERT INTO bot_avatar_images(botId,data) VALUES(?,?)")
        .run(targetId, Buffer.from(content.data, "base64"));
    }
    this.db
      .prepare("UPDATE bots SET avatarJson=? WHERE id=?")
      .run(JSON.stringify({ ...source, revision: 0 }), targetId);
  }
  save(
    botId: string,
    revision: number,
    choice:
      | { shape: AvatarStyle["shape"]; color: AvatarStyle["color"] }
      | ValidatedAvatar,
  ) {
    const old = this.read(botId);
    if (old.revision !== revision)
      throw new AppError("conflict", "头像已被更新，请重新打开编辑器后修改。");
    const next: AvatarStyle =
      "bytes" in choice
        ? { ...old, imageHash: choice.hash, revision: revision + 1 }
        : { ...choice, imageHash: null, revision: revision + 1 };
    if ("bytes" in choice)
      this.db
        .prepare(
          "INSERT INTO bot_avatar_images VALUES(?,?) ON CONFLICT(botId) DO UPDATE SET data=excluded.data",
        )
        .run(botId, choice.bytes);
    else
      this.db.prepare("DELETE FROM bot_avatar_images WHERE botId=?").run(botId);
    this.db
      .prepare("UPDATE bots SET avatarJson=? WHERE id=?")
      .run(JSON.stringify(next), botId);
  }
  content(access: AvatarAccess) {
    const meta = this.read(access.botId);
    if (meta.imageHash !== access.hash)
      throw new AppError("not_found", "头像版本已改变，请重新读取。");
    const row = this.db
      .prepare("SELECT data FROM bot_avatar_images WHERE botId=?")
      .get(access.botId);
    if (!row) throw new AppError("not_found", "此设备尚未缓存头像内容。");
    const bytes = z.instanceof(Uint8Array).parse(row?.data);
    if (createHash("sha256").update(bytes).digest("hex") !== access.hash)
      throw new AppError("unavailable", "头像内容完整性校验失败。");
    return { ...access, data: Buffer.from(bytes).toString("base64") };
  }
}
