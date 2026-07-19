/**
 * Action Item and audit record (TECH-SPEC §4.2, §4.5).
 *
 * `ActionItemContext` is deliberately the same shape for every item regardless
 * of which capability produced it. That uniformity is what lets the Action
 * Center triage, render and audit a capability it knows nothing about.
 */
import { z } from "zod";
import {
  ActionItemStatus,
  ExecutionMode,
  IsoDateTime,
  KebabId,
  ExecutionCapabilityId,
  Priority,
} from "./common.js";

export const TriggerReason = z.enum(["confidence", "policy", "value", "risk", "action_type"]);
export type TriggerReason = z.infer<typeof TriggerReason>;

export const ActionItemContext = z.object({
  what_happened: z.string().min(1),
  source: z.object({
    kind: z.string().min(1),
    id: z.string().min(1),
    link: z.string().optional(),
  }),
  /** The path the item travelled, e.g. ["email.received", "newsletter-digest.run"]. */
  provenance: z.array(z.string().min(1)),
  why_flagged: z.string(),
  trigger_reason: TriggerReason,
  confidence: z.number().min(0).max(1),
  decision_needed: z.string().min(1),
  /** Where Sandip reviews it, e.g. "inbox". */
  decision_surface: z.string().min(1),
  /** Where the action lands, e.g. "notion". */
  execution_surface: z.string().min(1),
  outcome_preview: z.string(),
});
export type ActionItemContext = z.infer<typeof ActionItemContext>;

/** What a capability's run() returns, pre-ingest. */
export const DraftActionItem = z.object({
  capability_id: KebabId,
  type: KebabId,
  context: ActionItemContext,
  /** Validated against the manifest's custom_attributes at ingest (§5.1). */
  custom: z.record(z.string(), z.unknown()),
  /** Capability-computed idempotency key, unique per (capability_id, dedupe_key). */
  dedupe_key: z.string().min(1),
});
export type DraftActionItem = z.infer<typeof DraftActionItem>;

export const ActionItemExecution = z.object({
  mode: ExecutionMode,
  capability: ExecutionCapabilityId,
  payload: z.record(z.string(), z.unknown()),
});
export type ActionItemExecution = z.infer<typeof ActionItemExecution>;

/** Persisted, post-ingest. */
export const ActionItem = DraftActionItem.extend({
  id: z.uuid(),
  status: ActionItemStatus,
  /** Response ids allowed for this instance, drawn from the manifest. */
  responses: z.array(z.string().min(1)),
  execution: ActionItemExecution,
  priority: Priority,
  deadline: IsoDateTime.nullable(),
  expires_at: IsoDateTime.nullable(),
  /**
   * When a deferred item returns to the Inbox. Set on the defer response and
   * cleared on the way out of `deferred`, so it is non-null only while the item
   * is actually snoozed (UI-SPEC §5.3).
   */
  defer_until: IsoDateTime.nullable().default(null),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type ActionItem = z.infer<typeof ActionItem>;

/**
 * Context fields exposed to policy predicates (§5.6). A capability's
 * `custom_attributes` may not shadow these, so `confidence` in a predicate
 * always means the OS-computed confidence and never a capability's own field.
 */
export const CONTEXT_VARIABLE_NAMES = [
  "what_happened",
  "why_flagged",
  "trigger_reason",
  "confidence",
  "decision_needed",
  "decision_surface",
  "execution_surface",
  "outcome_preview",
  "source_kind",
  "source_id",
] as const;

export type ContextVariableName = (typeof CONTEXT_VARIABLE_NAMES)[number];

/** Flattens an ActionItemContext into the predicate variable map. */
export function contextVariables(context: ActionItemContext): Record<ContextVariableName, unknown> {
  return {
    what_happened: context.what_happened,
    why_flagged: context.why_flagged,
    trigger_reason: context.trigger_reason,
    confidence: context.confidence,
    decision_needed: context.decision_needed,
    decision_surface: context.decision_surface,
    execution_surface: context.execution_surface,
    outcome_preview: context.outcome_preview,
    source_kind: context.source.kind,
    source_id: context.source.id,
  };
}

export const Actor = z.enum(["sandip", "policy", "system", "capability"]);
export type Actor = z.infer<typeof Actor>;

/** Append-only audit row (§9). Never updated, never deleted. */
export const ActionItemEvent = z.object({
  id: z.uuid(),
  action_item_id: z.uuid(),
  from_status: ActionItemStatus.nullable(),
  to_status: ActionItemStatus,
  actor: Actor,
  reason: z.string().optional(),
  /** Populated on edit-then-approve, and on a re-ingest that supersedes a draft. */
  payload_diff: z.record(z.string(), z.unknown()).optional(),
  created_at: IsoDateTime,
});
export type ActionItemEvent = z.infer<typeof ActionItemEvent>;
