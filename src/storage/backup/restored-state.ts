import type { DatabaseSync } from "node:sqlite";

/** Store calls this only on the isolated staged copy, inside its transaction after migration. */
export function fenceRestoredState(db: DatabaseSync) {
  db.exec(
    "DELETE FROM relay_settings; DELETE FROM relay_peers; DELETE FROM relay_outbox; DELETE FROM relay_inbox; DELETE FROM relay_packets; DELETE FROM relay_requests; DELETE FROM relay_cancellations; DELETE FROM relay_cache; DELETE FROM relay_dirty; DELETE FROM relay_journal;",
  );
  db.exec(
    "UPDATE cloud_chat_state SET receiving=1,cursor=0; DELETE FROM cloud_chat_outbox; DELETE FROM cloud_chat_collaboration_outbox; DELETE FROM cloud_chat_dirty; DELETE FROM cloud_chat_entities; UPDATE im_state SET cursor=0,notificationCursor=0; DELETE FROM im_rooms; DELETE FROM im_messages; DELETE FROM im_members; DELETE FROM im_receipts; DELETE FROM im_files;",
  );
  db.exec(`
    UPDATE plugins SET enabled=0;
    UPDATE plugin_calls SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'cancelled' END,detail='从备份恢复，不会重放插件调用。' WHERE status IN ('pending','approved','running');
    UPDATE runs SET status='unknown',error='从备份恢复，不能确认此后是否已执行；不会自动重发。' WHERE status IN ('queued','running','cancelling');
    UPDATE group_turns SET status='unknown',error='从备份恢复，成员操作不会自动重放。' WHERE status IN ('queued','running');
    UPDATE conversations SET threadId=NULL;
    UPDATE group_members SET threadId=NULL,contextSequence=0;
    DELETE FROM conversation_context;
    DELETE FROM group_context;
    UPDATE routines SET state='paused',nextAt=NULL,keyHash=NULL,revision=revision+1,error='从备份恢复，需手动启用并重新生成 Webhook 密钥。' WHERE state<>'deleted';
    UPDATE memory_jobs SET status='cancelled',error='从备份恢复，未自动重新提炼。' WHERE status IN ('queued','proposing','verifying','cancelling');
    UPDATE memory_scopes SET automatic=0,revision=revision+1;
    UPDATE approval_settings SET enabled=0,revision=revision+1;
    DELETE FROM directory_grants;
    UPDATE template_jobs SET status='unknown',error='从备份恢复，请核实原提交，不自动重新发布。' WHERE status IN ('queued','running');
    UPDATE deletions SET status='failed',error='从备份恢复，请核实资源后手动重试清理。' WHERE status IN ('queued','cleaning');
  `);
  db.exec("UPDATE cloud_chat_state SET receiving=0;");
}
