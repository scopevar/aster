import type { DatabaseSync } from "node:sqlite";
import { storageDiagnosticsSchema } from "../shared/diagnostics.js";

export function storageDiagnostics(db: DatabaseSync) {
  const states = new Set(
    storageDiagnosticsSchema.shape.runs.element.shape.state.options,
  );
  const grouped = (
    table: "runs" | "routines" | "template_jobs" | "memory_jobs",
    column: "status" | "state" = "status",
  ) => {
    const counts = new Map<string, number>();
    for (const row of db
      .prepare(
        `SELECT ${column} state,count(*) n FROM ${table} GROUP BY ${column}`,
      )
      .all()) {
      const parsed =
        storageDiagnosticsSchema.shape.runs.element.shape.state.safeParse(
          row.state,
        );
      const state =
        parsed.success && states.has(parsed.data) ? parsed.data : "other";
      counts.set(state, (counts.get(state) ?? 0) + Number(row.n));
    }
    return [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([state, count]) => ({ state, count }));
  };
  return storageDiagnosticsSchema.parse({
    schemaVersion: db.prepare("PRAGMA user_version").get()?.user_version,
    databasePageBytes:
      Number(db.prepare("PRAGMA page_count").get()?.page_count) *
      Number(db.prepare("PRAGMA page_size").get()?.page_size),
    records: db
      .prepare(
        "SELECT (SELECT count(*) FROM bots) bots,(SELECT count(*) FROM conversations) conversations,(SELECT count(*) FROM messages) messages,(SELECT count(*) FROM attachments) attachments,(SELECT count(*) FROM skills) skills,(SELECT count(*) FROM template_drafts) templates",
      )
      .get(),
    runs: grouped("runs"),
    routines: grouped("routines", "state"),
    publications: grouped("template_jobs"),
    memoryJobs: grouped("memory_jobs"),
  });
}
