import type { FileResult } from "../shared/files/files.js";

/** Keep image bytes in native MCP image blocks, never in the model's text budget. */
export function fileModelContent(
  value: FileResult,
): Array<
  | { type: "text"; text: string }
  | { type: "image"; mimeType: "image/png"; data: string }
> {
  if (value.action === "document") {
    const parsed = value.result;
    if (parsed.action === "render") {
      const { image, ...info } = parsed;
      return [
        { type: "text", text: JSON.stringify({ ...value, result: info }) },
        { type: "image", mimeType: "image/png", data: image },
      ];
    }
    if (parsed.action === "word.image" && parsed.image.data) {
      const { data, ...info } = parsed.image;
      return [
        {
          type: "text",
          text: JSON.stringify({
            ...value,
            result: { ...parsed, image: info },
          }),
        },
        { type: "image", mimeType: "image/png", data },
      ];
    }
  }
  return [{ type: "text", text: JSON.stringify(value) }];
}
