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

export type Actor = "sandip" | "policy" | "system" | "capability";

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
  created_at: string;
  updated_at: string;
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
