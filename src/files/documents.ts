import { basename } from "node:path";
import { inspectAttachment } from "../attachments/content.js";
import type { DocumentReader } from "../documents/reader.js";
import { AppError } from "../shared/core.js";
import type { FileRequest, FileResult } from "../shared/files/files.js";
import { officeReadOperationSchema } from "../shared/files/office.js";
import { pdfOperationSchema } from "../shared/files/documents.js";
import { readGrantedBytes } from "./read.js";

export async function readGrantedDocument(
  reader: DocumentReader,
  root: string,
  input: Extract<FileRequest["operation"], { action: "document" }>,
  signal: AbortSignal,
): Promise<FileResult> {
  const bytes = await readGrantedBytes(root, input.path, signal);
  signal.throwIfAborted();
  const name = basename(input.path.replaceAll("\\", "/"));
  const file = inspectAttachment(name, bytes);
  const pdf = pdfOperationSchema.safeParse(input.operation);
  let result;
  if (file.kind === "pdf") {
    if (!pdf.success)
      throw new AppError(
        "invalid_input",
        "PDF 请使用 info、text 或 render 操作。",
      );
    result = await reader.read(bytes, pdf.data, signal);
  } else if (file.kind === "docx" || file.kind === "table") {
    if (pdf.success)
      throw new AppError(
        "invalid_input",
        "DOCX 和表格请使用 word 或 table 操作。",
      );
    result = await reader.readOffice(
      bytes,
      name,
      file.kind,
      officeReadOperationSchema.parse(input.operation),
      signal,
    );
  } else
    throw new AppError(
      "invalid_input",
      "document 仅解析 PDF、DOCX 和电子表格，其他类型请使用 read。",
    );
  return { action: "document", name, hash: file.hash, result };
}
