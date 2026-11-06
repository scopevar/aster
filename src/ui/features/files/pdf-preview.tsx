import { Tooltip } from "../../components/tooltip.js";
import { Button } from "@heroui/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  getDocument,
  PDFWorker,
  TextLayer,
  AnnotationMode,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import type { Attachment } from "../../../shared/files/attachments.js";
import { attachmentContentSchema } from "../../../shared/files/attachments.js";
import { Modal } from "../../components/modal.js";
import { Icon } from "../../components/icons.js";
import { desktop, errorMessage } from "../../lib/client.js";
import "./pdf-preview.css";

/** One viewer owns its worker, decoded bytes, render queue and text layers. */
class PageQueue {
  private active = 0;
  private waiting: Array<() => void> = [];
  async run(signal: AbortSignal, work: () => Promise<void>) {
    signal.throwIfAborted();
    if (this.active >= 2)
      await new Promise<void>((resolve, reject) => {
        const release = () => {
          signal.removeEventListener("abort", abort);
          this.active++;
          resolve();
        };
        const abort = () => {
          this.waiting = this.waiting.filter((item) => item !== release);
          reject(signal.reason);
        };
        this.waiting.push(release);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    else this.active++;
    try {
      signal.throwIfAborted();
      await work();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

type Ready = {
  doc: PDFDocumentProxy;
  width: number;
  height: number;
  queue: PageQueue;
};
export function PdfPreview({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose(): void;
}) {
  const [ready, setReady] = useState<Ready | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(1),
    [width, setWidth] = useState(600),
    [pageNumber, setPageNumber] = useState(1),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const fail = useRef<(message: string) => void>(() => {});
  useEffect(() => {
    let disposed = false;
    let native: Worker | undefined,
      worker: PDFWorker | undefined,
      task: ReturnType<typeof getDocument> | undefined;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      // PDF.js needs its live worker's Terminate acknowledgement to release fonts and page caches.
      // Bound the graceful shutdown, then force release if a malformed document does not yield.
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        forceTimer = setTimeout(() => {
          console.error("PDF viewer cleanup deadline exceeded", attachment.id);
          resolve();
        }, 1000);
      });
      void Promise.race([task?.destroy() ?? Promise.resolve(), timeout])
        .catch(() => console.error("PDF viewer cleanup failed", attachment.id))
        .finally(() => {
          clearTimeout(forceTimer);
          native?.terminate();
          worker?.destroy();
        });
    };
    const failed = (message: string) => {
      if (!disposed) {
        setError(message);
        setReady(null);
        dispose();
      }
    };
    fail.current = failed;
    const timer = setTimeout(
      () => failed("PDF 打开超过 20 秒，已停止。可以重试或保存原文件。"),
      20000,
    );
    setError("");
    setReady(null);
    void desktop
      .attachmentContent({
        id: attachment.id,
        conversationId: attachment.conversationId,
      })
      .then(async (value) => {
        if (disposed) return;
        const content = attachmentContentSchema.parse(value);
        const bytes = Uint8Array.from(atob(content.data), (character) =>
          character.charCodeAt(0),
        );
        native = new Worker(new URL("./pdf.worker.mjs", location.href), {
          type: "module",
        });
        worker = PDFWorker.create({ port: native });
        task = getDocument({
          data: bytes,
          worker,
          enableXfa: false,
          stopAtErrors: true,
          useSystemFonts: false,
          verbosity: 0,
          cMapUrl: new URL("./pdf/cmaps/", location.href).href,
          standardFontDataUrl: new URL("./pdf/standard_fonts/", location.href)
            .href,
          wasmUrl: new URL("./pdf/wasm/", location.href).href,
          maxImageSize: 16_000_000,
        });
        const doc = await task.promise;
        if (disposed) return;
        if (doc.numPages > 1000)
          throw Error("PDF 超过 1,000 页预览上限，请拆分文件。原文件可保存。");
        const page = await doc.getPage(1),
          base = page.getViewport({ scale: 1 });
        validatePageSize(base);
        if (disposed) return;
        clearTimeout(timer);
        setReady({
          doc,
          width: base.width,
          height: base.height,
          queue: new PageQueue(),
        });
      })
      .catch((e) =>
        failed(
          e instanceof Error && e.name === "PasswordException"
            ? "PDF 已加密，请先解密再上传。原文件仍可保存。"
            : `无法打开 PDF：${errorMessage(e)}`,
        ),
      );
    return dispose;
  }, [attachment.id, attachment.conversationId, attempt]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const resize = new ResizeObserver(() => setWidth(node.clientWidth));
    resize.observe(node);
    return () => resize.disconnect();
  }, []);
  const scale =
    Math.max(0.25, Math.min(4, (width - 32) / (ready?.width ?? 600))) * zoom;
  const go = (value: number) => {
    const page = Math.max(1, Math.min(ready?.doc.numPages ?? 1, value));
    viewport.current
      ?.querySelector(`[data-page="${page}"]`)
      ?.scrollIntoView({ block: "start" });
    setPageNumber(page);
  };
  return (
    <Modal
      title={attachment.name}
      onClose={onClose}
      variant="pdf"
      actions={
        <>
          <div className="pdf-controls">
            <Tooltip content="缩小 PDF">
              <Button
                variant="ghost"
                size="sm"
                aria-label="缩小 PDF"
                isDisabled={!ready || zoom <= 0.5}
                onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
              >
                −
              </Button>
            </Tooltip>
            <Tooltip content="适应 PDF 宽度">
              <Button
                variant="ghost"
                size="sm"
                aria-label="适应 PDF 宽度"
                isDisabled={!ready}
                onClick={() => setZoom(1)}
              >
                {Math.round(scale * 100)}%
              </Button>
            </Tooltip>
            <Tooltip content="放大 PDF">
              <Button
                variant="ghost"
                size="sm"
                aria-label="放大 PDF"
                isDisabled={!ready || zoom >= 4}
                onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
              >
                +
              </Button>
            </Tooltip>
            <Tooltip content="上一页">
              <Button
                variant="ghost"
                size="sm"
                aria-label="上一页"
                isDisabled={!ready || pageNumber <= 1}
                onClick={() => go(pageNumber - 1)}
              >
                ‹
              </Button>
            </Tooltip>
            <span aria-label="PDF 页码">
              {pageNumber} / {ready?.doc.numPages ?? "—"}
            </span>
            <Tooltip content="下一页">
              <Button
                variant="ghost"
                size="sm"
                aria-label="下一页"
                isDisabled={!ready || pageNumber >= ready.doc.numPages}
                onClick={() => go(pageNumber + 1)}
              >
                ›
              </Button>
            </Tooltip>
          </div>
          <Tooltip content="保存附件">
            <Button
              variant="ghost"
              size="sm"
              isPending={saving}
              aria-label="保存附件"
              onClick={() => {
                setSaving(true);
                setSaveError("");
                void desktop
                  .saveAttachment({
                    id: attachment.id,
                    conversationId: attachment.conversationId,
                  })
                  .catch((e) => setSaveError(errorMessage(e)))
                  .finally(() => setSaving(false));
              }}
            >
              <Icon name="file" size={17} />
            </Button>
          </Tooltip>
        </>
      }
    >
      {saveError && (
        <p role="alert" className="error">
          {saveError}
        </p>
      )}
      <div
        className="pdf-scroll"
        ref={viewport}
        tabIndex={0}
        aria-label="PDF 页面"
        onScroll={() => {
          const node = viewport.current;
          if (!node) return;
          const pages = [...node.querySelectorAll<HTMLElement>("[data-page]")];
          const active = pages.find(
            (element) =>
              element.offsetTop + element.offsetHeight > node.scrollTop + 80,
          );
          if (active) setPageNumber(Number(active.dataset.page));
        }}
        onKeyDown={(event) => {
          if (["+", "=", "-", "PageDown", "PageUp"].includes(event.key)) {
            event.preventDefault();
            if (event.key === "PageDown") go(pageNumber + 1);
            else if (event.key === "PageUp") go(pageNumber - 1);
            else
              setZoom((value) =>
                Math.max(
                  0.5,
                  Math.min(4, value + (event.key === "-" ? -0.25 : 0.25)),
                ),
              );
          }
        }}
      >
        {error ? (
          <div className="pdf-notice" role="alert">
            <p>{error}</p>
            <Button
              variant="secondary"
              size="sm"
              className="secondary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试
            </Button>
          </div>
        ) : !ready ? (
          <p className="pdf-notice" role="status">
            正在打开 PDF…
          </p>
        ) : (
          Array.from({ length: ready.doc.numPages }, (_, index) => (
            <PdfPage
              key={index}
              ready={ready}
              number={index + 1}
              scale={scale}
              root={viewport.current}
              onFatal={(message) => fail.current(message)}
            />
          ))
        )}
      </div>
    </Modal>
  );
}

function validatePageSize(size: { width: number; height: number }) {
  if (
    ![size.width, size.height].every(
      (value) => Number.isFinite(value) && value > 0 && value <= 14400,
    )
  )
    throw Error("PDF 页面尺寸超过预览范围。");
}
function PdfPage({
  ready,
  number,
  scale,
  root,
  onFatal,
}: {
  ready: Ready;
  number: number;
  scale: number;
  root: HTMLElement | null;
  onFatal(message: string): void;
}) {
  const pageStyle: CSSProperties & { "--total-scale-factor": number } = {
    "--total-scale-factor": scale,
  };
  const frame = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false),
    [size, setSize] = useState({ width: ready.width, height: ready.height }),
    [status, setStatus] = useState("等待显示"),
    [error, setError] = useState("");
  const fatal = useRef(onFatal);
  fatal.current = onFatal;
  const previous = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries[0]?.isIntersecting ?? false),
      { root, rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let finished = false;
    let render: RenderTask | undefined, layer: TextLayer | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const surface = canvas.current,
      textNode = text.current;
    if (!surface || !textNode) return;
    setStatus("正在显示…");
    setError("");
    const task = previous.current
      .then(() =>
        ready.queue.run(controller.signal, async () => {
          textNode.replaceChildren();
          timer = setTimeout(
            () =>
              fatal.current(
                "PDF 页面处理超过 20 秒，已停止预览。可以重试或保存原文件。",
              ),
            20000,
          );
          const page = await ready.doc.getPage(number);
          try {
            controller.signal.throwIfAborted();
            const base = page.getViewport({ scale: 1 });
            validatePageSize(base);
            setSize({ width: base.width, height: base.height });
            const display = page.getViewport({ scale });
            // Bound backing pixels independently from zoom/DPI; layout and selectable text retain display scale.
            const rasterScale = Math.min(
              scale * Math.min(devicePixelRatio, 3),
              Math.sqrt(4_000_000 / (base.width * base.height)),
            );
            const raster = page.getViewport({ scale: rasterScale });
            surface.width = Math.max(1, Math.floor(raster.width));
            surface.height = Math.max(1, Math.floor(raster.height));
            render = page.render({
              canvas: surface,
              viewport: raster,
              annotationMode: AnnotationMode.ENABLE,
            });
            layer = new TextLayer({
              textContentSource: page.streamTextContent(),
              container: textNode,
              viewport: display,
            });
            await Promise.all([render.promise, layer.render()]);
            controller.signal.throwIfAborted();
            setStatus("");
          } finally {
            page.cleanup();
          }
        }),
      )
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(e));
          setStatus("");
        }
      })
      .finally(() => {
        finished = true;
        clearTimeout(timer);
        if (controller.signal.aborted) {
          textNode.replaceChildren();
          surface.width = 0;
          surface.height = 0;
        }
      });
    previous.current = task;
    return () => {
      controller.abort();
      clearTimeout(timer);
      render?.cancel();
      layer?.cancel();
      if (finished) {
        textNode.replaceChildren();
        surface.width = 0;
        surface.height = 0;
      }
    };
  }, [ready, number, scale, visible]);
  return (
    <div
      className="pdf-page-wrap"
      ref={frame}
      data-page={number}
      style={{ width: size.width * scale, height: size.height * scale }}
    >
      <div className="pdf-page" style={pageStyle}>
        <canvas ref={canvas} aria-label={`PDF 第 ${number} 页`} />
        <div className="textLayer" ref={text} />
        {(error || status) && (
          <p className="pdf-page-status" role={error ? "alert" : "status"}>
            {error || status}
          </p>
        )}
      </div>
      <span className="pdf-page-number">{number}</span>
    </div>
  );
}
