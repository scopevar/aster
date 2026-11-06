import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { AppError } from "../shared/core.js";
import {
  officeElementSchema,
  officeLink,
  type OfficeNode,
} from "../shared/files/office.js";

type HtmlNode = DefaultTreeAdapterMap["childNode"];
const removed = new Set([
  "script",
  "style",
  "link",
  "meta",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "form",
  "input",
  "button",
  "video",
  "audio",
]);

/** Turn untrusted converter output into data. React creates elements from this finite vocabulary. */
export function officeContent(html: string) {
  if (Buffer.byteLength(html) > 8 * 1024 * 1024)
    throw new AppError(
      "capacity",
      "DOCX 内容超过 8 MiB 预览上限，请拆分文档。",
    );
  const fragment = parseFragment(html),
    warnings = new Set<string>();
  let count = 0,
    characters = 0;
  const visit = (nodes: HtmlNode[], depth: number): OfficeNode[] => {
    if (depth > 64)
      throw new AppError("capacity", "DOCX 内容嵌套超过 64 层，无法安全预览。");
    const result: OfficeNode[] = [];
    for (const node of nodes) {
      if (++count > 20000)
        throw new AppError(
          "capacity",
          "DOCX 内容超过 20,000 个结构节点，请拆分文档。",
        );
      if (node.nodeName === "#text" && "value" in node) {
        characters += node.value.length;
        if (characters > 2_000_000)
          throw new AppError(
            "capacity",
            "DOCX 文字超过 200 万字符，未截断，请拆分文档。",
          );
        result.push({ kind: "text", text: node.value });
      } else if ("tagName" in node) {
        const tag = node.tagName.toLowerCase();
        if (removed.has(tag)) {
          warnings.add("文档中的脚本、嵌入对象或交互控件已阻止。");
          continue;
        }
        const attr = (name: string) =>
          node.attrs.find((attribute) => attribute.name === name)?.value;
        if (tag === "img") {
          const match = /^office-image:(\d{1,2})$/.exec(attr("src") ?? "");
          if (match && Number(match[1]) < 32)
            result.push({
              kind: "image",
              index: Number(match[1]),
              alt: (attr("alt") ?? "").slice(0, 2000),
            });
          else {
            result.push({ kind: "text", text: "[图片已阻止]" });
            warnings.add("外部图片或不支持的图片地址已阻止。");
          }
          continue;
        }
        const children = visit(node.childNodes, depth + 1);
        if (tag === "a") {
          const href = officeLink(attr("href") ?? "");
          if (!href) warnings.add("不安全或不支持的链接已转为普通文字。");
          result.push({ kind: "link", href, children });
          continue;
        }
        const element = officeElementSchema.safeParse(tag);
        if (!element.success) {
          result.push(...children);
          continue;
        }
        const numeric = (name: string, max: number) => {
          const raw = attr(name);
          if (raw === undefined) return undefined;
          const n = Number(raw);
          return Number.isSafeInteger(n) &&
            n >= (name === "start" ? 0 : 1) &&
            n <= max
            ? n
            : undefined;
        };
        const colspan = ["td", "th"].includes(tag)
          ? numeric("colspan", 200)
          : undefined;
        const rowspan = ["td", "th"].includes(tag)
          ? numeric("rowspan", 10000)
          : undefined;
        const start = tag === "ol" ? numeric("start", 1000000) : undefined;
        result.push({
          kind: "element",
          tag: element.data,
          children,
          ...(colspan === undefined ? {} : { colspan }),
          ...(rowspan === undefined ? {} : { rowspan }),
          ...(start === undefined ? {} : { start }),
        });
      }
    }
    return result;
  };
  const nodes = visit(fragment.childNodes, 0);
  const plain = (nodes: OfficeNode[]): string =>
    nodes
      .map((node) => {
        if (node.kind === "text") return node.text;
        if (node.kind === "image")
          return `[图片 ${node.index + 1}${node.alt ? `：${node.alt}` : ""}]`;
        const content = plain(node.children);
        if (node.kind === "link")
          return content + (node.href ? ` (${node.href})` : "");
        if (node.tag === "td" || node.tag === "th")
          return content.trim() + "\t";
        return (
          content +
          ([
            "p",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "tr",
            "li",
            "br",
            "hr",
            "blockquote",
            "pre",
          ].includes(node.tag)
            ? "\n"
            : "")
        );
      })
      .join("");
  const text = plain(nodes).trim();
  if (text.length > 2_000_000)
    throw new AppError(
      "capacity",
      "DOCX 文本超过 200 万字符，未截断，请拆分文档。",
    );
  return { nodes, text, warnings: [...warnings] };
}
