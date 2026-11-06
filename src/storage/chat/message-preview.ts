import { fromMarkdown } from "mdast-util-from-markdown";
import { unified } from "unified";
import { messageMarkdownPlugins } from "../../presentation/message-markdown.js";

const syntax = unified().use(messageMarkdownPlugins).freeze().data();
type MarkdownNode =
  | ReturnType<typeof fromMarkdown>
  | ReturnType<typeof fromMarkdown>["children"][number];

function plainText(node: MarkdownNode): string {
  switch (node.type) {
    case "definition":
    case "footnoteDefinition":
    case "footnoteReference":
    case "html":
      return "";
    case "break":
    case "thematicBreak":
      return " ";
    case "image":
    case "imageReference":
      return `[图片：${node.alt || "未命名"}]`;
  }
  if ("value" in node) return node.value;
  if ("children" in node) {
    const separator = [
      "root",
      "blockquote",
      "list",
      "listItem",
      "table",
      "tableRow",
    ].includes(node.type)
      ? " "
      : "";
    return node.children.map(plainText).join(separator);
  }
  return "";
}

export function messagePreview(source: string): string {
  const tree = fromMarkdown(source, {
    extensions: syntax.micromarkExtensions ?? [],
    mdastExtensions: syntax.fromMarkdownExtensions ?? [],
  });
  return plainTextPreview(plainText(tree));
}

export function plainTextPreview(source: string): string {
  return Array.from(source.replace(/\s+/g, " ").trim()).slice(0, 240).join("");
}
