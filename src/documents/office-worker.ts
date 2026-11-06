import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { AppError } from "../shared/core.js";
import { maxAttachmentBytes } from "../shared/files/attachments.js";
import {
  officeKindSchema,
  officeOperationSchema,
  officeResultSchema,
} from "../shared/files/office.js";
import { readWord } from "./word-reader.js";
import { readTable } from "./table-reader.js";

try {
  const input = z
    .object({
      bytes: z
        .instanceof(Uint8Array)
        .refine((bytes) => bytes.byteLength <= maxAttachmentBytes),
      name: z.string().min(1).max(240),
      kind: officeKindSchema,
      operation: officeOperationSchema,
    })
    .strict()
    .parse(workerData);
  const bytes = Buffer.from(input.bytes);
  const result =
    input.kind === "docx"
      ? await readWord(bytes, input.operation)
      : await readTable(bytes, input.name, input.operation);
  const validated = officeResultSchema.parse(result);
  if (Buffer.byteLength(JSON.stringify(validated)) > 16 * 1024 * 1024)
    throw new AppError("capacity", "文档返回内容超过 16 MiB，请拆分文件。");
  parentPort?.postMessage({ ok: true, result: validated });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error:
      error instanceof AppError
        ? { code: error.code, message: error.message }
        : {
            code: "invalid_input",
            message:
              "文档无法解析，可能已加密、损坏或采用不支持的格式。原文件仍保留。",
          },
  });
} finally {
  parentPort?.close();
}
