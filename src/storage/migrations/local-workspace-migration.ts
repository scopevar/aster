import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/** Keep legacy rows for recovery, while retiring cloud journals and execution admission. */
export function migrateLocalWorkspace(db: DatabaseSync) {
  for (const row of db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'cloud_%' OR name LIKE 'relay_%')",
    )
    .all()) {
    const name = z.string().parse(row.name);
    db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  }
  db.exec(`
    UPDATE cloud_chat_state SET enabled=0;
    UPDATE runs SET status='unknown',error='已迁移到本地版，请核实旧任务结果，不会自动重放。' WHERE status IN ('queued','running','cancelling');
    UPDATE group_turns SET status='unknown',error='本地版迁移保留旧成员执行结果，未重放。' WHERE status IN ('queued','running');
    UPDATE routines SET state='paused',nextAt=NULL,revision=revision+1,error='本地版迁移后需确认并启用。' WHERE state<>'deleted';
    UPDATE memory_jobs SET status='cancelled',error='本地版迁移后未重放旧记忆任务。' WHERE status IN ('queued','proposing','verifying','cancelling');
    UPDATE template_jobs SET status='unknown',error='云端发布已退役，保留原提交记录，不再发送。' WHERE status IN ('queued','running');
  `);
}
