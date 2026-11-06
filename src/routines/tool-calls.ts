import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  routineReceiptSchema,
  routineToolResultSchema,
  type RoutineToolResult,
  type RoutineReceipt,
} from "../shared/routines.js";
/** Durable tool-call audit. Admission limits and tool authorization belong to the routine service. */
export class RoutineToolCallStorage {
  constructor(private readonly db: DatabaseSync) {}
  isAutomatic(runId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM routine_events WHERE runId=?")
      .get(runId);
  }
  find(runId: string, callId: string) {
    const row = this.db
      .prepare(
        "SELECT fingerprint,resultJson FROM routine_tool_calls WHERE runId=? AND callId=?",
      )
      .get(runId, callId);
    return row
      ? {
          fingerprint: z.string().parse(row.fingerprint),
          result: routineToolResultSchema.parse(
            JSON.parse(z.string().parse(row.resultJson)),
          ),
        }
      : undefined;
  }
  count(runId: string) {
    return Number(
      this.db
        .prepare("SELECT count(*) n FROM routine_tool_calls WHERE runId=?")
        .get(runId)?.n,
    );
  }
  bytes() {
    return Number(
      this.db
        .prepare(
          "SELECT COALESCE(sum(length(CAST(resultJson AS BLOB))),0) n FROM routine_tool_calls",
        )
        .get()?.n,
    );
  }
  record(
    runId: string,
    callId: string,
    fingerprint: string,
    result: RoutineToolResult,
    receipt: RoutineReceipt | null,
  ) {
    this.db
      .prepare("INSERT INTO routine_tool_calls VALUES(?,?,?,?,?,?)")
      .run(
        runId,
        callId,
        fingerprint,
        JSON.stringify(result),
        "messageId" in result ? result.messageId : null,
        receipt ? JSON.stringify(receipt) : null,
      );
  }
  receipt(messageId: string) {
    const row = this.db
      .prepare("SELECT receiptJson FROM routine_tool_calls WHERE messageId=?")
      .get(messageId);
    return row
      ? routineReceiptSchema.parse(
          JSON.parse(z.string().parse(row.receiptJson)),
        )
      : null;
  }
}
