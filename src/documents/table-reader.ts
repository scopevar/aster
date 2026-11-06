import { z } from "zod";
import * as xlsx from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";
import { AppError } from "../shared/core.js";
import {
  sheetCellSchema,
  type OfficeOperation,
  type OfficeResult,
  type SheetSummary,
} from "../shared/files/office.js";
import { inspectOfficeArchive } from "./office-archive.js";

// The ESM entry needs explicit codepage tables for legacy XLS encodings.
// All cells cross an unknown-input validator before being used by application code.
xlsx.set_cptable(cptable);
const cellInput = z
  .object({
    t: z.enum(["b", "n", "e", "s", "d", "z"]).optional(),
    v: z
      .union([
        z.string().max(32767),
        z.number().finite(),
        z.boolean(),
        z.date(),
        z.null(),
      ])
      .optional(),
    w: z.string().max(32767).optional(),
    f: z.string().max(32767).optional(),
  })
  .passthrough();
const cellAddress = /^[A-Z]{1,3}[1-9]\d{0,6}$/;

export async function readTable(
  bytes: Buffer,
  name: string,
  operation: OfficeOperation,
): Promise<OfficeResult> {
  if (operation.action !== "table.info" && operation.action !== "table.range")
    throw new AppError("invalid_input", "此操作需要 DOCX 文档。");
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (!["xlsx", "xls", "csv", "tsv"].includes(extension ?? ""))
    throw new AppError("invalid_input", "不支持的表格格式。");
  const warnings = new Set<string>();
  if (extension === "xlsx") {
    const names = await inspectOfficeArchive(bytes);
    if (!names.has("xl/workbook.xml") || !names.has("[Content_Types].xml"))
      throw new AppError("invalid_input", "文件不是有效的 XLSX 工作簿。");
    if (
      [...names].some((name) =>
        /vbaProject|externalLinks\/|embeddings\//i.test(name),
      )
    )
      warnings.add("宏、外部链接和嵌入对象不会执行或刷新。");
  } else if (
    extension === "xls" &&
    !bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))
  ) {
    throw new AppError(
      "invalid_input",
      "XLS 文件头无效。请使用真正的 Excel 二进制工作簿。",
    );
  }
  const delimited = extension === "csv" || extension === "tsv";
  const workbook = xlsx.read(
    delimited ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : bytes,
    {
      type: delimited ? "string" : "buffer",
      raw: delimited,
      cellFormula: true,
      sheetStubs: true,
      cellText: true,
      cellDates: false,
      bookVBA: false,
      bookFiles: false,
      ...(delimited ? { FS: extension === "tsv" ? "\t" : "," } : {}),
    },
  );
  if (workbook.SheetNames.length > 200)
    throw new AppError("capacity", "工作簿超过 200 张工作表，请拆分文件。");
  if (!workbook.SheetNames.length)
    throw new AppError("invalid_input", "文件中没有可读取的工作表。");
  let cells = 0;
  const summaries: SheetSummary[] = workbook.SheetNames.map(
    (sheetName, index) => {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet)
        throw new AppError("invalid_input", "工作表索引与内容不一致。");
      let rows = 0,
        columns = 0;
      // Derive used dimensions from actual cells rather than trusting a malicious !ref.
      for (const key of Object.keys(sheet)) {
        if (key.startsWith("!")) continue;
        if (!cellAddress.test(key))
          throw new AppError("invalid_input", "工作表含有无效的单元格地址。");
        if (++cells > 200000)
          throw new AppError(
            "capacity",
            "工作簿超过 200,000 个存储单元格，请拆分文件。",
          );
        const position = xlsx.utils.decode_cell(key);
        if (position.r >= 1048576 || position.c >= 16384)
          throw new AppError("capacity", "工作表坐标超过 Excel 范围。");
        rows = Math.max(rows, position.r + 1);
        columns = Math.max(columns, position.c + 1);
      }
      if (sheet["!merges"]?.length)
        warnings.add("合并单元格保留左上角值；网格按真实单元格地址显示。");
      return {
        index,
        name: sheetName,
        rows,
        columns,
        hidden: Boolean(workbook.Workbook?.Sheets?.[index]?.Hidden),
      };
    },
  );
  warnings.add("公式显示原式及文件保存的结果，不在本应用中重新计算。");
  if (operation.action === "table.info")
    return {
      action: operation.action,
      sheets: summaries,
      warnings: [...warnings],
    };
  const summary = summaries[operation.sheet];
  if (!summary) throw new AppError("invalid_input", "工作表不存在。");
  if (
    operation.row > Math.max(1, summary.rows) ||
    operation.column > Math.max(1, summary.columns)
  )
    throw new AppError("invalid_input", "请求范围起点超过工作表内容范围。");
  const sheet = workbook.Sheets[summary.name];
  if (!sheet) throw new AppError("invalid_input", "工作表内容不存在。");
  const result: z.infer<typeof sheetCellSchema>[][] = [];
  let outputSize = 0;
  for (
    let row = operation.row;
    row <= Math.min(summary.rows, operation.row + operation.rows - 1);
    row++
  ) {
    const values: z.infer<typeof sheetCellSchema>[] = [];
    for (
      let column = operation.column;
      column <=
      Math.min(summary.columns, operation.column + operation.columns - 1);
      column++
    ) {
      const address = xlsx.utils.encode_cell({ r: row - 1, c: column - 1 });
      const raw: unknown = sheet[address];
      const cell = raw === undefined ? {} : cellInput.parse(raw);
      const value =
        cell.t === "z"
          ? null
          : cell.v instanceof Date
            ? cell.v.toISOString()
            : (cell.v ?? null);
      const text = cell.w ?? (value === null ? "" : String(value));
      const entry = sheetCellSchema.parse({
        address,
        text,
        value,
        formula: cell.f ?? null,
        error: cell.t === "e",
      });
      outputSize += Buffer.byteLength(JSON.stringify(entry));
      if (outputSize > 1024 * 1024)
        throw new AppError(
          "capacity",
          "单次表格内容超过 1 MiB，请缩小行列范围后重试。",
        );
      values.push(entry);
    }
    result.push(values);
  }
  return {
    action: operation.action,
    sheet: summary,
    row: operation.row,
    column: operation.column,
    cells: result,
    warnings: [...warnings],
  };
}
