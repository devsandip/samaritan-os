/**
 * Hand-mirrored copies of the server contracts in `src/types/*` (TECH-SPEC §4).
 *
 * They are duplicated rather than imported because the SPA is a separate tsconfig
 * with its own module resolution, and pulling in zod-inferred types would drag
 * the whole backend graph into the browser bundle. The trade is that a contract
 * change has to be mirrored here by hand; everything the UI reads is narrow
 * enough (and covered by `docs/TECH-SPEC.md` §4) for that to stay cheap.
 */

export type ActionItemStatus =
  | "pending"
  | "in_review"
  | "approved"
  | "awaiting_confirmation"
  | "rejected"
  | "deferred"
  | "executed"
  | "failed"
  | "expired";

export type ExecutionMode = "guided" | "assisted" | "automated";

export type Priority = "low" | "normal" | "high" | "urgent";

export type ResponseOutcome = "execute" | "guided" | "discard" | "defer" | "ask_more_info";

export type RenderLayout = "card" | "form" | "document" | "diff";

export type TriggerReason = "confidence" | "policy" | "value" | "risk" | "action_type";

export type Actor = "sandip" | "policy" | "system" | "capability" | "assistant";

export interface ActionItemContext {
  what_happened: string;
  source: { kind: string; id: string; link?: string };
  provenance: string[];
  why_flagged: string;
  trigger_reason: TriggerReason;
  confidence: number;
  decision_needed: string;
  decision_surface: string;
  execution_surface: string;
  outcome_preview: string;
}

export interface ActionItemExecution {
  mode: ExecutionMode;
  capability: string;
  payload: Record<string, unknown>;
}

export interface ActionItem {
  id: string;
  capability_id: string;
  type: string;
  status: ActionItemStatus;
  dedupe_key: string;
  priority: Priority;
  /** Response ids allowed for this instance. Labels come from the manifest. */
  responses: string[];
  context: ActionItemContext;
  custom: Record<string, unknown>;
  execution: ActionItemExecution;
  deadline: string | null;
  expires_at: string | null;
  /** When a deferred item returns to the inbox. Non-null only while deferred. */
  defer_until: string | null;
  task_id?: string | null;
  run_id?: string | null;
  payload_hash: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export type TaskLane = "general" | "coding" | "research" | "operations";

export type TaskStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "awaiting_review"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TaskOrigin = "ui" | "telegram" | "mcp" | "api";

export interface Task {
  id: string;
  goal: string;
  lane: TaskLane;
  origin: TaskOrigin;
  status: TaskStatus;
  revision: number;
  runner: string;
  parent_task_id: string | null;
  result_summary: string | null;
  created_at: string;
  updated_at: string;
}

export type RunRecordStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled"
  | "interrupted"
  | "skipped";

export interface RunRecord {
  id: string;
  task_id: string | null;
  capability_id: string | null;
  runner: "in-process" | "child-process" | "worker";
  remote_run_id: string | null;
  admission_key: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  fencing_generation: number;
  status: RunRecordStatus;
  cost_usd: number;
  started_at: string;
  heartbeat_at: string;
  ended_at: string | null;
  error: string | null;
}

export type ArtifactKind = "file" | "diff" | "url" | "transcript" | "brief";

export interface Artifact {
  id: string;
  task_id: string | null;
  run_id: string | null;
  kind: ArtifactKind;
  path_or_url: string;
  content_hash: string;
  media_type: string;
  created_at: string;
}

export interface ActivityEvent {
  cursor: number;
  id: string;
  task_id: string | null;
  run_id: string | null;
  capability_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface SourceRule {
  source_id: string;
  muted: boolean;
  snoozed_until: string | null;
  paused: boolean;
  updated_at: string;
}

export interface SyncCursor {
  source: string;
  cursor: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

/** GET /api/now: today, what needs Sandip, and what is running (D2). */
export interface NowSummary {
  inbox: ActionItem[];
  inbox_count: number;
  /** Tasks still in play: queued, running, waiting on Sandip, or interrupted. */
  tasks: Task[];
  running: RunRecord[];
  /** The rest of today's meetings. */
  meetings: {
    id: string;
    title: string;
    starts_at: string;
    ends_at: string | null;
    attendees: string[];
  }[];
  source_rules: SourceRule[];
  sync_cursors: SyncCursor[];
  worker: { month_spend_usd: number; monthly_budget_usd: number };
}

export interface ActionItemEvent {
  id: string;
  action_item_id: string;
  from_status: ActionItemStatus | null;
  to_status: ActionItemStatus;
  actor: Actor;
  reason?: string;
  payload_diff?: Record<string, unknown>;
  created_at: string;
}

export type CustomAttributeType = "string" | "string[]" | "number" | "boolean";

export interface RenderSpec {
  layout: RenderLayout;
  primary?: string;
  secondary?: string;
  badges?: string[];
}

export interface ResponseSpec {
  id: string;
  label: string;
  outcome: ResponseOutcome;
}

export interface ActionItemTypeSpec {
  type: string;
  render: RenderSpec;
  custom_attributes: Record<string, CustomAttributeType>;
  responses: ResponseSpec[];
  execution: { mode: ExecutionMode; capability: string; action_type?: string };
  policy?: {
    escalate_when?: string;
    auto_complete_when?: string;
    confidence_threshold?: number;
  };
  priority: Priority;
  ttl: string | null;
}

/** The per-type mode block GET /api/capabilities appends alongside `emits`. */
export interface CapabilityTypeStatus {
  type: string;
  declared_mode: ExecutionMode;
  effective_mode: ExecutionMode;
  degraded_reason?: string;
}

export interface CapabilityManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  owner: string;
  enabled: boolean;
  entrypoint: string;
  trigger: { mode: string; cron?: string; on?: string[]; command?: string };
  emits: ActionItemTypeSpec[];
  requires_capabilities: string[];
  delivery?: { channels: string[]; quiet_hours?: string };
  audit: boolean;
  timeout_ms: number;
  /** Added by the API on top of the stored manifest. */
  types: CapabilityTypeStatus[];
  /** Run telemetry, written by the Run Layer. Null until it has ever run. */
  last_run_at: string | null;
  last_run_status: string | null;
}

/** What POST /api/capabilities/:id/run answers with. */
export interface RunReport {
  capability_id: string;
  status: "ok" | "error" | "timeout" | "skipped";
  error?: string;
  duration_ms: number;
  accepted: { id: string; dedupe_key: string; status: string }[];
  rejected: { errors: string[] }[];
  logs: string[];
  missing_inputs: string[];
}

export interface LoadProblem {
  dir: string;
  capabilityId?: string;
  message: string;
}

export interface RoutingEntry {
  action_type: string;
  provider: string;
  account: string;
  mode: ExecutionMode;
  fallback_provider?: string;
  execution_capability?: Partial<Record<ExecutionMode, string>>;
  locked: boolean;
}

export interface Health {
  status: string;
  capabilities: number;
  problems: number;
}

export interface BackupRecord {
  id: string;
  backup_path: string;
  size_bytes: number;
  integrity_ok: boolean;
  created_at: string;
}

export interface ConnectionStatusEntry {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  keychain_account: string;
  status: "connected" | "not_configured" | "error";
  last_sync_at: string | null;
  last_error: string | null;
}

export interface SystemHealth {
  status: string;
  schema_version?: number;
  sqlite_integrity: string;
  keychain: { accessible: boolean; detail: string };
  billing: {
    allowed: boolean;
    mtd_spend_usd: number;
    monthly_cap_usd: number;
    remaining_usd: number;
  };
  backups: BackupRecord[];
  sync_cursors: SyncCursor[];
  capabilities: number;
  problems: number;
}

export type RetrievalPath = "structured" | "semantic" | "hybrid";

/** One cited source behind a Recall answer (§5.5). */
export interface RecallCitation {
  /** Where it came from: obsidian, journal, audit, action_item. */
  kind: string;
  /** A file path (+ #heading) or the source's own id. */
  ref: string;
  excerpt?: string;
}

export interface RecallAnswer {
  answer: string;
  citations: RecallCitation[];
  retrieval_path: RetrievalPath;
}

export interface RecallStats {
  sources: number;
  chunks: number;
  embedded: number;
  vector_index: boolean;
}

export interface BatchOutcome {
  id: string;
  result: "applied" | "skipped" | "error";
  status?: ActionItemStatus;
  reason?: string;
  rule?: string;
}

export interface BatchResult {
  applied: BatchOutcome[];
  skipped: BatchOutcome[];
  errors: BatchOutcome[];
}
