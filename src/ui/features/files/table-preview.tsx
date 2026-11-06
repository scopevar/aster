import { Button, Tabs } from "@heroui/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Attachment } from "../../../shared/files/attachments.js";
import {
  officeResultSchema,
  type SheetSummary,
  type SheetRange,
} from "../../../shared/files/office.js";
import { useOfficeRead } from "./use-office-read.js";
import { desktop, errorMessage } from "../../lib/client.js";

const rowHeight = 28,
  columnWidth = 120,
  headerWidth = 48;
type Position = { row: number; column: number };
function columnLabel(column: number): string {
  let result = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26))
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}
const address = (cell: Position) => columnLabel(cell.column) + cell.row;

export function TablePreview({
  attachment,
  sheets,
}: {
  attachment: Attachment;
  sheets: SheetSummary[];
}) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheet = sheets[sheetIndex];
  return (
    <div className="table-preview">
      {sheet && (
        <SheetGrid key={sheet.index} attachment={attachment} sheet={sheet} />
      )}
      <Tabs
        selectedKey={String(sheetIndex)}
        onSelectionChange={(key) => setSheetIndex(Number(key))}
      >
        <Tabs.List className="sheet-tabs" aria-label="工作表">
          {sheets.map((sheet) => (
            <Tabs.Tab key={sheet.index} id={String(sheet.index)}>
              {sheet.name}
              {sheet.hidden ? "（隐藏表）" : ""}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>
    </div>
  );
}
function SheetGrid({
  attachment,
  sheet,
}: {
  attachment: Attachment;
  sheet: SheetSummary;
}) {
  const rows = Math.min(10000, sheet.rows),
    columns = Math.min(200, sheet.columns);
  const viewport = useRef<HTMLDivElement>(null),
    drag = useRef(false);
  const [scroll, setScroll] = useState({
    top: 0,
    left: 0,
    height: 500,
    width: 900,
  });
  const [anchor, setAnchor] = useState<Position>({ row: 1, column: 1 }),
    [selected, setSelected] = useState<Position>({ row: 1, column: 1 });
  const [copying, setCopying] = useState(false),
    [copyError, setCopyError] = useState("");
  const copyingRequest = useRef<string | null>(null);
  const [cache, setCache] = useState<Map<string, SheetRange>>(new Map());
  const startRow = Math.max(1, Math.floor(scroll.top / rowHeight) - 3),
    endRow = Math.min(
      rows,
      Math.ceil((scroll.top + scroll.height) / rowHeight) + 3,
    );
  const startColumn = Math.max(1, Math.floor(scroll.left / columnWidth) - 1),
    endColumn = Math.min(
      columns,
      Math.ceil((scroll.left + scroll.width) / columnWidth) + 1,
    );
  const blocks: { key: string; row: number; column: number }[] = [];
  for (
    let row = Math.floor((startRow - 1) / 100) * 100 + 1;
    row <= endRow;
    row += 100
  )
    for (
      let column = Math.floor((startColumn - 1) / 32) * 32 + 1;
      column <= endColumn;
      column += 32
    )
      blocks.push({ key: `${row}:${column}`, row, column });
  const visibleKeys = blocks.map((block) => block.key).join(",");
  const missing = blocks.find((block) => !cache.has(block.key));
  const capacityReached =
    !!missing &&
    cache.size >= 16 &&
    [...cache.keys()].every((key) => blocks.some((block) => block.key === key));
  const blockRow = missing?.row ?? 1,
    blockColumn = missing?.column ?? 1;
  const { result, error, retry } = useOfficeRead(
    attachment,
    {
      action: "table.range",
      sheet: sheet.index,
      row: blockRow,
      column: blockColumn,
      rows: 100,
      columns: Math.min(32, Math.max(1, columns - blockColumn + 1)),
    },
    !!missing && !capacityReached,
  );
  useEffect(() => {
    if (result?.action !== "table.range") return;
    setCache((old) => {
      const key = `${result.row}:${result.column}`;
      if (old.get(key) === result) return old;
      const next = new Map(old);
      next.set(key, result);
      const needed = new Set(visibleKeys.split(","));
      while (next.size > 16) {
        const outside = [...next.keys()].find((key) => !needed.has(key));
        // A stale response may arrive after resizing. Never evict another visible block to admit it.
        next.delete(outside ?? key);
      }
      return next;
    });
  }, [result, visibleKeys]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(() =>
      setScroll((value) => ({
        ...value,
        height: node.clientHeight,
        width: node.clientWidth,
      })),
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      const id = copyingRequest.current;
      copyingRequest.current = null;
      if (id)
        void desktop
          .cancelDocumentPreview(id)
          .catch((error) =>
            console.error(
              "Spreadsheet copy cancellation failed",
              errorMessage(error),
            ),
          );
    };
  }, []);
  const ranges = [...cache.values()].reverse();
  const cell = (row: number, column: number) => {
    for (const range of ranges) {
      const value = range.cells[row - range.row]?.[column - range.column];
      if (value) return value;
    }
    return undefined;
  };
  const current = cell(selected.row, selected.column);
  const bounds = {
    top: Math.min(anchor.row, selected.row),
    bottom: Math.max(anchor.row, selected.row),
    left: Math.min(anchor.column, selected.column),
    right: Math.max(anchor.column, selected.column),
  };
  const copy = async () => {
    if (copying || !rows || !columns) return;
    if (
      (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1) >
      10000
    ) {
      setCopyError("单次复制最多 10,000 个单元格，请缩小选择范围。");
      return;
    }
    setCopying(true);
    setCopyError("");
    let output = "";
    try {
      for (let row = bounds.top; row <= bounds.bottom; row += 100) {
        const requestId = crypto.randomUUID();
        copyingRequest.current = requestId;
        const value = officeResultSchema.parse(
          await desktop.documentPreview({
            requestId,
            id: attachment.id,
            conversationId: attachment.conversationId,
            operation: {
              action: "table.range",
              sheet: sheet.index,
              row,
              column: bounds.left,
              rows: Math.min(100, bounds.bottom - row + 1),
              columns: bounds.right - bounds.left + 1,
            },
          }),
        );
        if (copyingRequest.current !== requestId) return;
        if (value.action !== "table.range")
          throw Error("复制结果不是表格范围。");
        for (const line of value.cells)
          output +=
            line
              .map((cell) =>
                /[\t\r\n"]/.test(cell.text)
                  ? `"${cell.text.replaceAll('"', '""')}"`
                  : cell.text,
              )
              .join("\t") + "\n";
        if (new TextEncoder().encode(output).byteLength > 1024 * 1024)
          throw Error("复制内容超过 1 MiB，请缩小选择范围。");
      }
      await desktop.copyText(output.replace(/\n$/, ""));
    } catch (error) {
      setCopyError(errorMessage(error));
    } finally {
      copyingRequest.current = null;
      setCopying(false);
    }
  };
  const move = (next: Position, extend: boolean) => {
    next = {
      row: Math.max(1, Math.min(rows, next.row)),
      column: Math.max(1, Math.min(columns, next.column)),
    };
    setSelected(next);
    if (!extend) setAnchor(next);
    const node = viewport.current;
    if (!node) return;
    const top = (next.row - 1) * rowHeight,
      left = (next.column - 1) * columnWidth;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + rowHeight > node.scrollTop + node.clientHeight - rowHeight)
      node.scrollTop = top + 2 * rowHeight - node.clientHeight;
    if (left < node.scrollLeft) node.scrollLeft = left;
    else if (
      left + columnWidth >
      node.scrollLeft + node.clientWidth - headerWidth
    )
      node.scrollLeft = left + columnWidth + headerWidth - node.clientWidth;
  };
  const keyboard = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copy();
      return;
    }
    const next = { ...selected };
    if (event.key === "ArrowDown") next.row++;
    else if (event.key === "ArrowUp") next.row--;
    else if (event.key === "ArrowLeft") next.column--;
    else if (event.key === "ArrowRight") next.column++;
    else if (event.key === "Home") {
      next.column = 1;
      if (event.ctrlKey) next.row = 1;
    } else if (event.key === "End") {
      next.column = columns;
      if (event.ctrlKey) next.row = rows;
    } else if (event.key === "PageDown")
      next.row += Math.max(1, Math.floor(scroll.height / rowHeight) - 1);
    else if (event.key === "PageUp")
      next.row -= Math.max(1, Math.floor(scroll.height / rowHeight) - 1);
    else return;
    event.preventDefault();
    move(next, event.shiftKey);
  };
  return (
    <>
      <div className="sheet-value-bar">
        <span aria-label="选中范围">
          {address(anchor)}
          {address(anchor) !== address(selected) ? `:${address(selected)}` : ""}
        </span>
        <span
          className="sheet-value"
          title={current?.formula ? `=${current.formula}` : current?.text}
        >
          {current?.formula ? `=${current.formula}` : (current?.text ?? "")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void copy()}
          isPending={copying}
          isDisabled={!rows}
        >
          {copying ? "正在复制…" : "复制选区"}
        </Button>
      </div>
      {(rows < sheet.rows || columns < sheet.columns) && (
        <p className="sheet-limit" role="status">
          预览显示前 10,000 行、200 列；原表共 {sheet.rows} 行、{sheet.columns}{" "}
          列。保存原文件可查看全部，Bot 可按范围读取。
        </p>
      )}
      {copyError && (
        <p role="alert" className="office-error">
          {copyError}
        </p>
      )}
      {capacityReached && (
        <p className="office-error" role="alert">
          当前可见区域过大，请缩小窗口，或保存原文件查看。
        </p>
      )}
      {missing && error && !capacityReached && (
        <div className="office-error" role="alert">
          {error}
          <Button variant="ghost" size="sm" onClick={retry}>
            重试读取
          </Button>
        </div>
      )}
      <div
        ref={viewport}
        className="sheet-scroll"
        role="grid"
        aria-label={sheet.name}
        aria-rowcount={rows + 1}
        aria-colcount={columns + 1}
        aria-readonly="true"
        tabIndex={0}
        onKeyDown={keyboard}
        onScroll={(event) => {
          const { scrollTop, scrollLeft } = event.currentTarget;
          setScroll((value) => ({
            ...value,
            top: scrollTop,
            left: scrollLeft,
          }));
        }}
        onPointerUp={() => {
          drag.current = false;
        }}
        onPointerLeave={() => {
          drag.current = false;
        }}
      >
        {!rows || !columns ? (
          <p className="office-notice">此工作表为空</p>
        ) : (
          <div
            className="sheet-surface"
            style={{
              height: (rows + 1) * rowHeight,
              width: headerWidth + columns * columnWidth,
            }}
          >
            <div
              className="sheet-corner"
              style={{ left: scroll.left, top: scroll.top }}
            />
            {Array.from(
              { length: Math.max(0, endColumn - startColumn + 1) },
              (_, index) => index + startColumn,
            ).map((column) => (
              <div
                key={column}
                role="columnheader"
                aria-colindex={column + 1}
                className="sheet-column"
                style={{
                  left: headerWidth + (column - 1) * columnWidth,
                  top: scroll.top,
                }}
              >
                {columnLabel(column)}
              </div>
            ))}
            {Array.from(
              { length: Math.max(0, endRow - startRow + 1) },
              (_, index) => index + startRow,
            ).map((row) => (
              <div role="row" aria-rowindex={row + 1} key={row}>
                <div
                  className="sheet-row"
                  role="rowheader"
                  style={{ top: row * rowHeight, left: scroll.left }}
                >
                  {row}
                </div>
                {Array.from(
                  { length: Math.max(0, endColumn - startColumn + 1) },
                  (_, index) => index + startColumn,
                ).map((column) => {
                  const value = cell(row, column),
                    active = row === selected.row && column === selected.column,
                    chosen =
                      row >= bounds.top &&
                      row <= bounds.bottom &&
                      column >= bounds.left &&
                      column <= bounds.right;
                  return (
                    <div
                      key={column}
                      role="gridcell"
                      aria-label={columnLabel(column) + row}
                      aria-colindex={column + 1}
                      aria-selected={chosen}
                      className={`sheet-cell ${chosen ? "chosen" : ""} ${active ? "active" : ""} ${value?.error ? "cell-error" : ""}`}
                      style={{
                        left: headerWidth + (column - 1) * columnWidth,
                        top: row * rowHeight,
                      }}
                      title={value?.text}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        viewport.current?.focus();
                        drag.current = true;
                        setSelected({ row, column });
                        if (!event.shiftKey) setAnchor({ row, column });
                      }}
                      onPointerEnter={() => {
                        if (drag.current) setSelected({ row, column });
                      }}
                    >
                      {value ? (
                        value.text
                      ) : (
                        <span className="sheet-pending">…</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="sheet-status" role="status">
        {sheet.rows} 行 × {sheet.columns} 列 · 只读 ·{" "}
        {capacityReached || (missing && error)
          ? "读取失败"
          : missing
            ? "正在读取可见区域…"
            : "公式使用文件保存的结果"}
      </div>
    </>
  );
}
