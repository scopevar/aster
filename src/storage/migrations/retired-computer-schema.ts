import type { DatabaseSync } from "node:sqlite";

// Retain released schema steps and historical data without a desktop runtime.
export const retiredComputerSchema = {
  computer(db: DatabaseSync) {
    db.exec(
      `CREATE TABLE computers(botId TEXT PRIMARY KEY REFERENCES bots(id),revision INTEGER NOT NULL,generation INTEGER NOT NULL,status TEXT NOT NULL,control TEXT NOT NULL,controlRevision INTEGER NOT NULL,detail TEXT NOT NULL);`,
    );
  },
  maintenance(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS computer_maintenance(
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL REFERENCES bots(id),
        operation TEXT NOT NULL CHECK(operation IN ('snapshot','recover','reset')),
        snapshotId TEXT,
        status TEXT NOT NULL CHECK(status IN ('committed','rolled_back')),
        detail TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS taught_skills(
        skillId TEXT PRIMARY KEY REFERENCES skills(id),
        botId TEXT NOT NULL REFERENCES bots(id),
        actionJson TEXT NOT NULL,
        observedJson TEXT NOT NULL,
        reused INTEGER NOT NULL DEFAULT 0 CHECK(reused IN (0,1))
      );
    `);
  },
  maintenanceOperations(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE computer_maintenance_v29(
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL REFERENCES bots(id),
        operation TEXT NOT NULL CHECK(operation IN ('snapshot','recover','reset','restore_browser','restore_apps','install_app')),
        snapshotId TEXT,
        status TEXT NOT NULL CHECK(status IN ('committed','rolled_back')),
        detail TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      INSERT INTO computer_maintenance_v29(id,botId,operation,snapshotId,status,detail,createdAt)
        SELECT id,botId,operation,snapshotId,status,detail,createdAt FROM computer_maintenance;
      DROP TABLE computer_maintenance;
      ALTER TABLE computer_maintenance_v29 RENAME TO computer_maintenance;
    `);
  },
  approval(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE approval_settings(
        id INTEGER PRIMARY KEY CHECK(id=1),
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
      );
      INSERT INTO approval_settings(id, enabled) VALUES(1, 0);
      CREATE TABLE approval_rules(
        id TEXT PRIMARY KEY,
        decision TEXT NOT NULL CHECK(decision IN ('ask','allow','deny')),
        actionJson TEXT NOT NULL UNIQUE,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE approval_audits(
        id TEXT PRIMARY KEY,
        computerCallId TEXT NOT NULL REFERENCES computer_calls(id) ON DELETE CASCADE,
        ruleId TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('ask','allow','deny')),
        reason TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX approval_audit_call ON approval_audits(computerCallId);
    `);
  },
  approvalReview(db: DatabaseSync) {
    db.exec(`ALTER TABLE approval_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE computer_calls ADD COLUMN policyRevision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE computer_calls ADD COLUMN manualDecision INTEGER NOT NULL DEFAULT 0 CHECK(manualDecision IN (0,1));
      CREATE TABLE approval_conditions(id TEXT PRIMARY KEY, condition TEXT NOT NULL UNIQUE, decision TEXT NOT NULL CHECK(decision IN ('ask','allow','deny')), createdAt INTEGER NOT NULL);
      CREATE TABLE approval_reviews(callId TEXT PRIMARY KEY REFERENCES computer_calls(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, inputJson TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reviewing','decided','abandoned','manual')),
        decision TEXT CHECK(decision IN ('ask','allow','deny')), reason TEXT NOT NULL, ruleIdsJson TEXT NOT NULL);
    `);
  },
  recordings(db: DatabaseSync) {
    db.exec(`CREATE TABLE teaching_recordings (
      botId TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
      id TEXT NOT NULL UNIQUE, conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL, controlRevision INTEGER NOT NULL, revision INTEGER NOT NULL,
      purpose TEXT NOT NULL, state TEXT NOT NULL, sequence INTEGER NOT NULL, bytes INTEGER NOT NULL,
      startedAt INTEGER NOT NULL, heartbeatAt INTEGER NOT NULL, detail TEXT NOT NULL, incomplete INTEGER NOT NULL DEFAULT 0 CHECK(incomplete IN (0,1)));
      CREATE TABLE teaching_chunks (
      recordingId TEXT NOT NULL REFERENCES teaching_recordings(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, hash TEXT NOT NULL, data BLOB NOT NULL,
      PRIMARY KEY(recordingId,sequence));
      CREATE TABLE teaching_runs(runId TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE);`);
  },
};
