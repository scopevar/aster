import { AppError } from "../../shared/core.js";
import type {
  DocumentOperation,
  DocumentResult,
} from "../../shared/files/documents.js";
import type { DocumentStorage } from "./documents.js";
import type { Job } from "../job.js";
import type { RunStorage } from "../runs/runs.js";
type Context = {
  documents: DocumentStorage;
  transaction<T>(fn: () => T): T;
  changed(): void;
  canWrite(job: Job): boolean;
  getRun: RunStorage["getRun"];
};
/** Domain coordination uses the Store owner's synchronous transaction. */
export class DocumentOperations {
  constructor(private readonly context: Context) {}
  private requireDocumentRun(job: Job) {
    if (
      !this.context.canWrite(job) ||
      this.context.getRun(job.id)?.status !== "running"
    )
      throw new AppError("unauthorized", "运行已经结束，不能继续读取文档。");
  }
  documentBegin(job: Job, callId: string, operation: DocumentOperation) {
    return this.context.transaction(() => {
      this.requireDocumentRun(job);
      const result = this.context.documents.begin(job, callId, operation);
      this.context.changed();
      return result;
    });
  }
  documentContent(job: Job, id: string) {
    this.requireDocumentRun(job);
    return this.context.documents.content(job, id);
  }
  documentList(job: Job, after?: string) {
    this.requireDocumentRun(job);
    return this.context.documents.list(job, after);
  }
  documentComplete(job: Job, id: string, result: DocumentResult) {
    this.context.transaction(() => {
      this.requireDocumentRun(job);
      this.context.documents.complete(id, result);
      this.context.changed();
    });
  }
  documentEnd(id: string, detail: string, cancelled: boolean) {
    this.context.transaction(() => {
      this.context.documents.end(id, detail, cancelled);
      this.context.changed();
    });
  }
}
