import { z } from "zod";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { AgentInput } from "../chat/agent.js";
import { attachmentSchema } from "../shared/files/attachments.js";
import { AppError } from "../shared/core.js";
import { workerRoutes } from "../shared/protocol.js";

type MarkdownNode = {
  type: string;
  url?: string | undefined;
  children?: MarkdownNode[] | undefined;
  position?:
    | {
        start: { offset?: number | undefined };
        end: { offset?: number | undefined };
      }
    | undefined;
};

function artifactLinks(text: string) {
  const links: Array<{
    path: string;
    start: number;
    end: number;
    label: string;
  }> = [];
  const visit = (node: MarkdownNode) => {
    if (
      (node.type === "link" || node.type === "image") &&
      node.url?.startsWith("sandbox:/workspace/")
    ) {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const labelStart = start + (node.type === "image" ? 2 : 1);
      links.push({
        path: decodeURIComponent(node.url.slice("sandbox:".length)),
        start,
        end,
        label: text.slice(labelStart, text.indexOf("]", labelStart)),
      });
      return;
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(text));
  return links;
}

/** File links are handed off by the application; the model has no separate export tool. */
export async function deliverPiArtifacts(
  input: AgentInput,
  messages: ReadonlyMap<string, string>,
) {
  for (const [messageId, text] of messages) {
    const links = artifactLinks(text);
    if (!links.length) continue;
    if (!input.toolAccess)
      throw new AppError("unavailable", "当前运行没有文件交付通道。");
    const paths = [...new Set(links.map((link) => link.path))];
    if (paths.length > 8)
      throw new AppError("capacity", "单条回复最多交付八个文件。");
    const response = await fetch(
      `http://127.0.0.1:${input.toolAccess.port}${workerRoutes.toolsArtifacts}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.toolAccess.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messageId, paths }),
        signal: input.signal,
      },
    );
    if (!response.ok)
      throw new AppError(
        "unavailable",
        "生成文件未能确认为聊天附件，请核实文件交付状态。",
      );
    const result = z
      .object({ attachments: z.array(attachmentSchema).max(8) })
      .parse(await response.json());
    if (result.attachments.length !== paths.length)
      throw new AppError("unknown", "文件交付结果不完整，请核实已有附件。");
    let delivered = text;
    for (const link of links.toReversed())
      delivered =
        delivered.slice(0, link.start) + link.label + delivered.slice(link.end);
    input.onEvent({
      type: "text",
      itemId: messageId,
      text: delivered,
      complete: true,
    });
  }
}
