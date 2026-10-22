// Schema ownership is shared by ConversationDatabase and TurnStore. Version zero
// is the unversioned alpha schema; compatibility probes run only during adoption.
const migrations = [
  function conversations(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        repository_id TEXT,
        remote_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'complete',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS message_activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        source TEXT NOT NULL,
        activity_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(message_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        output TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','complete','error','rejected')),
        permission_source TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_last_opened ON projects(last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_session_sequence ON messages(session_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_message_activities_message_sequence ON message_activities(message_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_message_activities_session_sequence ON message_activities(session_id, message_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_tool_executions_session_created ON tool_executions(session_id, created_at ASC);
    `);

    for (const [table, column, definition] of [
      ['sessions', 'project_id', 'TEXT REFERENCES projects(id) ON DELETE SET NULL'],
      ['sessions', 'archived_at', 'INTEGER'],
      ['sessions', 'deleted_at', 'INTEGER'],
      ['messages', 'attachments_json', 'TEXT'],
      ['tool_executions', 'message_id', 'TEXT'],
    ]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_project_updated ON sessions(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_archived_updated ON sessions(archived_at, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_deleted ON sessions(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_tool_executions_message_created ON tool_executions(session_id, message_id, created_at ASC);
    `);
  },
  function turns(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_session_id TEXT,
        project_id TEXT,
        status TEXT NOT NULL,
        phase TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session_updated
        ON runs(session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS queued_turns (
        queue_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        queued_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_queued_turns_session_state
        ON queued_turns(session_id, status, queued_at ASC, queue_id ASC);

      CREATE TABLE IF NOT EXISTS runtime_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        run_id TEXT,
        queue_id TEXT,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_events_session_sequence
        ON runtime_events(session_id, sequence ASC);

      CREATE TABLE IF NOT EXISTS runtime_store_migrations (
        id TEXT PRIMARY KEY,
        migrated_at INTEGER NOT NULL
      );
    `);

    const columns = db.prepare('PRAGMA table_info(runs)').all();
    if (!columns.some((column) => column.name === 'phase')) db.exec('ALTER TABLE runs ADD COLUMN phase TEXT');
    db.prepare(`
      UPDATE runs
      SET phase=CASE status
        WHEN 'starting' THEN 'preparing'
        WHEN 'running' THEN 'streaming'
        WHEN 'waiting' THEN 'waiting_for_user'
        WHEN 'settling' THEN 'settling'
        WHEN 'complete' THEN 'complete'
        WHEN 'stopped' THEN 'stopped'
        WHEN 'interrupted' THEN 'interrupted'
        ELSE 'error'
      END
      WHERE phase IS NULL OR TRIM(phase)=''
    `).run();
    db.exec(`
      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        session_id TEXT,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        schema_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_command_receipts_session_updated
        ON command_receipts(session_id, updated_at DESC);
    `);
  },
  function projections(db) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(kind UNINDEXED,item_id UNINDEXED,session_id UNINDEXED,title,content,tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS search_index_progress (kind TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL);
      INSERT OR IGNORE INTO search_index_progress VALUES ('session', 0), ('message', 0);

      DROP TRIGGER IF EXISTS cuppet_run_start_from_assistant_message;
      DROP TRIGGER IF EXISTS cuppet_run_settling_from_assistant_message;

      CREATE TRIGGER cuppet_run_start_from_assistant_message
      AFTER INSERT ON messages
      WHEN NEW.role='assistant'
        AND NEW.status='streaming'
        AND NOT EXISTS (SELECT 1 FROM runs WHERE run_id=NEW.id)
      BEGIN
        INSERT INTO runs (
          run_id,session_id,source_session_id,project_id,status,phase,error,created_at,updated_at
        ) VALUES (
          NEW.id,
          NEW.session_id,
          NULL,
          (SELECT project_id FROM sessions WHERE id=NEW.session_id),
          'starting',
          'preparing',
          NULL,
          NEW.created_at,
          NEW.updated_at
        );
        INSERT INTO runtime_events (
          session_id,run_id,queue_id,sequence,type,payload_json,schema_version,created_at
        ) VALUES (
          NEW.session_id,
          NEW.id,
          NULL,
          (SELECT COALESCE(MAX(sequence),0)+1 FROM runtime_events WHERE session_id=NEW.session_id),
          'run.started',
          '{"status":"starting","phase":"preparing","source":"assistant_message"}',
          1,
          NEW.created_at
        );
      END;

      CREATE TRIGGER cuppet_run_settling_from_assistant_message
      AFTER UPDATE OF status ON messages
      WHEN OLD.role='assistant'
        AND OLD.status='streaming'
        AND NEW.status IN ('complete','stopped','interrupted','error')
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE run_id=NEW.id AND status IN ('starting','running','waiting')
        )
      BEGIN
        UPDATE runs
        SET status='settling', phase='settling', updated_at=NEW.updated_at
        WHERE run_id=NEW.id AND status IN ('starting','running','waiting');
        INSERT INTO runtime_events (
          session_id,run_id,queue_id,sequence,type,payload_json,schema_version,created_at
        ) VALUES (
          NEW.session_id,
          NEW.id,
          NULL,
          (SELECT COALESCE(MAX(sequence),0)+1 FROM runtime_events WHERE session_id=NEW.session_id),
          'run.settling',
          '{"status":"settling","phase":"settling","messageStatus":"' || NEW.status || '"}',
          1,
          NEW.updated_at
        );
      END;
    `);
  },
];

export const DATABASE_SCHEMA_VERSION = migrations.length;

export function migrateDatabase(db) {
  const checkVersion = () => {
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (version > DATABASE_SCHEMA_VERSION) {
      throw new Error(`Database schema ${version} is newer than supported schema ${DATABASE_SCHEMA_VERSION}; use a newer Cuppet app.`);
    }
    return version;
  };
  // Refuse a newer database before changing journal settings, schema or recovery state.
  checkVersion();
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = checkVersion();
    for (let index = version; index < migrations.length; index++) {
      migrations[index](db);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
