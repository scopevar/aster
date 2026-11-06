import { Disclosure } from "../../components/disclosure.js";
import { Button } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { diagramSaveResultSchema } from "../../../shared/files/diagram-export.js";
import { desktop, errorMessage } from "../../lib/client.js";
import { Modal } from "../../components/modal.js";
import {
  diagramExportError,
  diagramResult,
  diagramSourceError,
  diagramSvgMessage,
} from "./diagram-contract.js";

export function DiagramPreview({
  source,
  onClose,
}: {
  source: string;
  onClose(): void;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <Modal title="图表" onClose={onClose} wide>
      <DiagramAttempt
        key={`${attempt}:${source}`}
        source={source}
        onClose={onClose}
        retry={() => setAttempt((value) => value + 1)}
      />
    </Modal>
  );
}
function DiagramAttempt({
  source,
  retry,
  onClose,
}: {
  source: string;
  retry(): void;
  onClose(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const alive = useRef(true);
  const pendingExport = useRef(false);
  const exportTimer = useRef<number | undefined>(undefined);
  const [id] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(100);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [exportError, setExportError] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(exportTimer.current);
    };
  }, []);
  useEffect(() => {
    const invalid = diagramSourceError(source);
    if (invalid) {
      setError(invalid);
      setState("error");
      return;
    }
    const timeout = window.setTimeout(() => {
      setError("图表加载超过 8 秒，可重试或查看源码");
      setState("error");
    }, 8_000);
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow) return;
      const exported = diagramSvgMessage.safeParse(event.data);
      if (exported.success) {
        if (exported.data.id !== id || !pendingExport.current) return;
        pendingExport.current = false;
        window.clearTimeout(exportTimer.current);
        // Desktop owns the file. This page does not insert the SVG markup.
        void desktop
          .saveDiagram({ svg: exported.data.svg })
          .then((raw) => {
            if (!alive.current) return;
            setExportNotice(diagramSaveResultSchema.parse(raw).notice);
            setExportError("");
          })
          .catch((failure: unknown) => {
            if (alive.current) setExportError(errorMessage(failure));
          })
          .finally(() => {
            if (alive.current) setExporting(false);
          });
        return;
      }
      const failed = diagramExportError.safeParse(event.data);
      if (failed.success) {
        if (failed.data.id !== id || !pendingExport.current) return;
        pendingExport.current = false;
        window.clearTimeout(exportTimer.current);
        setExporting(false);
        setExportError(failed.data.error);
        return;
      }
      const parsed = diagramResult.safeParse(event.data);
      if (!parsed.success || parsed.data.id !== id) return;
      window.clearTimeout(timeout);
      if (parsed.data.state === "closed") {
        onClose();
        return;
      }
      setState(parsed.data.state);
      setError(parsed.data.error ?? "");
    };
    window.addEventListener("message", receive);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
    };
  }, [id, source, onClose]);
  const requestExport = () => {
    if (state !== "ready" || pendingExport.current) return;
    const target = frame.current?.contentWindow;
    if (!target) return;
    pendingExport.current = true;
    setExporting(true);
    setExportNotice("");
    setExportError("");
    window.clearTimeout(exportTimer.current);
    exportTimer.current = window.setTimeout(() => {
      if (!pendingExport.current) return;
      pendingExport.current = false;
      setExporting(false);
      setExportError("图表导出没有回应，可重试。");
    }, 5_000);
    target.postMessage({ version: 1, id, type: "export" }, "*");
  };
  return (
    <div className="diagram-preview">
      <div className="code-toolbar">
        <label>
          缩放{" "}
          <input
            aria-label="图表缩放"
            type="range"
            min="50"
            max="300"
            step="25"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </label>
        <output>{zoom}%</output>
        <Button
          variant="ghost"
          size="sm"
          isDisabled={state !== "ready" || exporting}
          onClick={requestExport}
        >
          导出 SVG
        </Button>
      </div>
      {exportNotice && <p role="status">{exportNotice}</p>}
      {exportError && <p role="alert">{exportError}</p>}
      {state === "loading" && <p role="status">正在排版图表…</p>}
      {state === "error" ? (
        <div role="alert">
          <p>{error || "图表无法排版"}</p>
          <Button variant="ghost" size="sm" onClick={retry}>
            重新查看
          </Button>
        </div>
      ) : (
        <div className="diagram-scroll">
          <div
            style={{
              width: `${zoom}%`,
              height: `${Math.round((420 * zoom) / 100)}px`,
            }}
          >
            <iframe
              ref={frame}
              title="隔离图表"
              src="./diagram-frame.html"
              sandbox="allow-scripts"
              style={{
                width: `${10_000 / zoom}%`,
                height: "420px",
                transform: `scale(${zoom / 100})`,
                transformOrigin: "top left",
              }}
              onLoad={() =>
                frame.current?.contentWindow?.postMessage(
                  { version: 1, id, source },
                  "*",
                )
              }
            />
          </div>
        </div>
      )}
      <Disclosure title={<>图表源码</>}>
        <pre>{source}</pre>
      </Disclosure>
    </div>
  );
}
