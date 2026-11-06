import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentInput } from "../chat/agent.js";
import { AppError } from "../shared/core.js";
import { maxAttachmentBytes } from "../shared/files/attachments.js";
import { estimateContextTokens } from "../shared/chat/context-budget.js";
function canonical(path: string) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Only immutable product-materialized inputs are read; model file access stays disabled. */
export async function piInputs(input: AgentInput, contextWindow: number) {
  const images: ImageContent[] = [],
    parts = [input.text];
  for (const attachment of input.attachments ?? []) {
    input.signal.throwIfAborted();
    if (!["text", "image"].includes(attachment.kind)) {
      parts.push(
        "Received attachment (read /inputs to find its sandbox path, then process with shell/Python; do not infer content): " +
          JSON.stringify({
            id: attachment.id,
            name: attachment.name,
            kind: attachment.kind,
          }),
      );
      continue;
    }
    const path = resolve(attachment.path);
    if (
      canonical(path) !==
        canonical(join(input.workspace, "attachments", basename(path))) ||
      canonical(await realpath(path)) !== canonical(path) ||
      (await lstat(path)).isSymbolicLink()
    )
      throw new AppError("unauthorized", "Pi 附件不属于当前成员的输入范围。");
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxAttachmentBytes)
        throw new AppError("invalid_input", "Pi 附件不是有界普通文件。");
      const bytes = await file.readFile();
      input.signal.throwIfAborted();
      if (bytes.byteLength > maxAttachmentBytes)
        throw new AppError("capacity", "Pi 附件超过大小限制。");
      if (attachment.kind === "image") {
        const extension = extname(path).toLowerCase();
        const mimeType =
          extension === ".png"
            ? "image/png"
            : [".jpg", ".jpeg"].includes(extension)
              ? "image/jpeg"
              : "image/webp";
        images.push({
          type: "image",
          mimeType,
          data: bytes.toString("base64"),
        });
      } else
        parts.push(
          `Read-only attachment ${JSON.stringify({ id: attachment.id, name: attachment.name })}:\n${bytes.toString("utf8")}`,
        );
    } finally {
      await file.close();
    }
  }
  const text = parts.join("\n\n");
  const reserve = Math.min(16384, Math.floor(contextWindow / 4));
  if (
    estimateContextTokens(text + input.instructions) + images.length * 4096 >
    contextWindow - reserve
  )
    throw new AppError(
      "capacity",
      "本次消息、资料或附件超过所选模型的输入预算；未静默丢弃。",
    );
  return { text, images };
}
