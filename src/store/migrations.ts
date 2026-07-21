/**
 * Action Store schema (TECH-SPEC §4.4).
 *
 * Migrations are embedded as strings rather than kept as .sql files because
 * `tsc` does not copy non-TS assets into dist/, and a migration that silently
 * fails to load after a build is the worst possible failure mode for the one
 * component every other component reads through.
 *
 * Forward-only. Never edit an applied migration; add a new one.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE capabilities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,       -- full parsed manifest; source of truth
  enabled INTEGER NOT NULL DEFAULT 1,
  registered_at TEXT NOT NULL,
  last_run_at TEXT,
  last_run_status TEXT
);

CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,                -- scheduled|event|manual|continuous
  cron TEXT,
  on_events TEXT,                    -- JSON array
  command TEXT,
  claude_scheduled_task_id TEXT,     -- set by the scheduler-sync adapter; nullable
  next_fire_at TEXT
);
CREATE INDEX idx_triggers_capability ON triggers(capability_id);

CREATE TABLE action_items (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capabilities(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  context_json TEXT NOT NULL,
  custom_json TEXT NOT NULL,
  responses_json TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  deadline TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(capability_id, dedupe_key)  -- re-ingest is an upsert against this key (§5.1)
);
CREATE INDEX idx_action_items_status ON action_items(status);
CREATE INDEX idx_action_items_capability ON action_items(capability_id);

CREATE TABLE action_item_events (    -- append-only audit trail
  id TEXT PRIMARY KEY,
  action_item_id TEXT NOT NULL REFERENCES action_items(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  payload_diff_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_item ON action_item_events(action_item_id);

-- §9: append-only is enforced in code AND backstopped here, so a stray UPDATE or
-- DELETE from any client (including a sqlite3 shell) aborts rather than quietly
-- rewriting the record that recall depends on to answer "why did this happen".
CREATE TRIGGER action_item_events_no_update
BEFORE UPDATE ON action_item_events
BEGIN
  SELECT RAISE(ABORT, 'action_item_events is append-only (TECH-SPEC section 9)');
END;

CREATE TRIGGER action_item_events_no_delete
BEFORE DELETE ON action_item_events
BEGIN
  SELECT RAISE(ABORT, 'action_item_events is append-only (TECH-SPEC section 9)');
END;

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  action_item_id TEXT NOT NULL REFERENCES action_items(id),
  mode TEXT NOT NULL,
  capability TEXT NOT NULL,          -- execution-registry id
  idempotency_key TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,              -- pending|succeeded|failed|staged
  result_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(idempotency_key, attempt)
);
CREATE INDEX idx_executions_item ON executions(action_item_id);

CREATE TABLE routing_config (
  action_type TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  mode TEXT NOT NULL,
  fallback_provider TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,               -- execution-capability id, e.g. notion.insight.create
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  account TEXT,
  scopes_json TEXT,
  last_verified_at TEXT
);

-- Recall / RAG support (§7)
CREATE TABLE recall_chunks (
  rowid INTEGER PRIMARY KEY,
  source_kind TEXT NOT NULL,         -- obsidian|email|slack|transcript
  source_path TEXT NOT NULL,
  heading TEXT,
  chunk_text TEXT NOT NULL,
  embedding BLOB,                    -- float32[] consumed by sqlite-vec
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_recall_chunks_source ON recall_chunks(source_path);

CREATE VIRTUAL TABLE recall_chunks_fts USING fts5(
  chunk_text, source_path, source_kind, content='recall_chunks', content_rowid='rowid'
);

-- Structured mirrors kept fresh by write-through on execute() plus a
-- reconciliation poller (§7).
CREATE TABLE notion_decisions (
  id TEXT PRIMARY KEY, title TEXT, rationale TEXT, project TEXT,
  reversibility TEXT, notion_url TEXT, last_edited_time TEXT
);
CREATE TABLE notion_insights (
  id TEXT PRIMARY KEY, title TEXT, body TEXT, tags TEXT,
  notion_url TEXT, last_edited_time TEXT
);
CREATE TABLE ticktick_tasks (
  id TEXT PRIMARY KEY, title TEXT, list TEXT, due TEXT,
  status TEXT, last_synced_at TEXT
);
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY, title TEXT, starts_at TEXT, ends_at TEXT,
  attendees TEXT, last_synced_at TEXT
);

-- Per-source cursors for the incremental pollers (§7). Never a global timestamp:
-- a failed poll must not advance any other source's cursor.
CREATE TABLE sync_cursors (
  source TEXT PRIMARY KEY,           -- e.g. "notion.decisions"
  cursor TEXT,
  last_success_at TEXT,
  last_error TEXT
);
`,
  },
  {
    version: 2,
    name: "delivery_queue",
    sql: `
-- Delivery holds notifications during quiet hours (§2.2) and flushes them after
-- the window. This is a table rather than an in-memory queue because v0 has no
-- daemon: the CLI process that queued a notification exits immediately, and an
-- in-memory queue would drop everything sent overnight.
CREATE TABLE delivery_queue (
  id TEXT PRIMARY KEY,
  action_item_id TEXT NOT NULL REFERENCES action_items(id),
  channel TEXT NOT NULL,             -- telegram
  body TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  deliver_after TEXT,                -- null means "as soon as possible"
  delivered_at TEXT,
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_delivery_pending ON delivery_queue(delivered_at, deliver_after);
`,
  },
  {
    version: 3,
    name: "defer_until",
    sql: `
-- When a snoozed item comes back (UI-SPEC §5.3). Deferred previously had no
-- resurface time at all, so an item sent there stayed there: nothing swept it
-- back to pending and the Deferred view had no time to render.
ALTER TABLE action_items ADD COLUMN defer_until TEXT;

-- Partial: the resurface sweep only ever reads rows that are actually snoozed,
-- and every other row has defer_until NULL.
CREATE INDEX idx_action_items_defer_until
  ON action_items(defer_until) WHERE defer_until IS NOT NULL;
`,
  },
  {
    version: 4,
    name: "execution_guided_fields",
    sql: `
-- A staged execution's deep link and instructions are top-level on
-- ExecutionResult, but only result.result was persisted, so both were dropped
-- on write. The registry replays a settled attempt instead of re-running the
-- adapter (§10), and a replay that cannot return the link hands back a "staged"
-- result with nothing to open.
ALTER TABLE executions ADD COLUMN guided_link TEXT;
ALTER TABLE executions ADD COLUMN guided_instructions TEXT;
`,
  },
  {
    version: 5,
    name: "recall_index",
    sql: `
-- Recall's bookkeeping (§7). recall_chunks and recall_chunks_fts already exist
-- from migration 1; what was missing is everything needed to keep them in sync
-- and to know when a source no longer needs re-reading.
--
-- The vec0 virtual table is NOT created here. It is an extension table, so it
-- only exists once sqlite-vec is loaded, and a migration that assumes the
-- extension would make the whole database unopenable without it. Recall creates
-- it on demand instead, and falls back to scanning when the extension is absent.
ALTER TABLE recall_chunks ADD COLUMN content_hash TEXT;
ALTER TABLE recall_chunks ADD COLUMN chunk_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recall_chunks ADD COLUMN source_ref TEXT;

CREATE INDEX idx_recall_chunks_kind ON recall_chunks(source_kind);

-- One row per indexed source document, so a reindex can skip anything whose
-- content hash is unchanged rather than re-embedding the whole vault.
CREATE TABLE recall_sources (
  source_path TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  embedded INTEGER NOT NULL DEFAULT 0,   -- 0 while chunks exist but vectors do not
  indexed_at TEXT NOT NULL
);
CREATE INDEX idx_recall_sources_kind ON recall_sources(source_kind);
`,
  },
  {
    version: 6,
    name: "seen_events",
    sql: `
-- The Event Bus's source-level dedup (§2.2, §12 step 18). A message can arrive
-- via both a webhook and a poller, so every SamaritanEvent carries a stable
-- source id (a Gmail message id, a file path + mtime), and the bus records it
-- here before dispatching. A second delivery of the same id finds the row
-- already present and is dropped, so an overlapping webhook and poll fire the
-- target capability only once.
--
-- The id is the whole dedup key. Listeners namespace it (e.g. "gmail:<msgid>",
-- "file:<path>@<mtime>") so two sources cannot collide on a bare integer.
CREATE TABLE seen_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  seen_at TEXT NOT NULL
);
CREATE INDEX idx_seen_events_seen_at ON seen_events(seen_at);
`,
  },
];
