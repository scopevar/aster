import mermaid from "mermaid";
import {
  diagramExportRequest,
  diagramInput,
  diagramSourceError,
} from "./diagram-contract.js";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "default",
  maxTextSize: 12_000,
  maxEdges: 200,
  suppressErrorRendering: true,
  flowchart: { htmlLabels: false },
  htmlLabels: false,
});
let started = false;
let activeId: string | undefined;
function replyExport(id: string, error: string) {
  parent.postMessage({ version: 1, id, type: "export-error", error }, "*");
}
// Render starts once. A later export reads that SVG and posts the string back.
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== parent) return;
  const requested = diagramExportRequest.safeParse(event.data);
  if (requested.success) {
    if (!activeId || requested.data.id !== activeId) return;
    const svg = document.querySelector("#diagram-root svg");
    if (!(svg instanceof SVGSVGElement)) {
      replyExport(activeId, "图表尚未排版完成。");
      return;
    }
    const serialized = new XMLSerializer().serializeToString(svg);
    if (serialized.length > 2_000_000) {
      replyExport(activeId, "图表超过导出大小限制。");
      return;
    }
    parent.postMessage(
      { version: 1, id: activeId, type: "svg", svg: serialized },
      "*",
    );
    return;
  }
  if (started) return;
  const parsed = diagramInput.safeParse(event.data);
  if (!parsed.success) return;
  started = true;
  const { id, source } = parsed.data;
  activeId = id;
  const reply = (state: "ready" | "error", error?: string) =>
    parent.postMessage(
      { version: 1, id, state, ...(error ? { error } : {}) },
      "*",
    );
  void (async () => {
    const invalid = diagramSourceError(source);
    if (invalid) throw new Error(invalid);
    await mermaid.parse(source);
    const rendered = await mermaid.render("diagram", source);
    const container = document.getElementById("diagram-root");
    if (!container) throw new Error("图表容器不可用");
    // Only Mermaid's strict-mode output enters this opaque, network-disabled frame.
    container.innerHTML = rendered.svg;
    reply("ready");
  })().catch((error: unknown) =>
    reply(
      "error",
      error instanceof Error ? error.message.slice(0, 500) : "图表无法排版",
    ),
  );
});
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a"))
    event.preventDefault();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeId) {
    event.preventDefault();
    parent.postMessage({ version: 1, id: activeId, state: "closed" }, "*");
  }
});
