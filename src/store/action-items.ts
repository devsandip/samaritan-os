/**
 * Action Item persistence (TECH-SPEC §12 step 5).
 *
 * `transition()` is the only code path in the system allowed to change an
 * action item's status, and it always writes the matching `action_item_events`
 * row inside the same transaction. That coupling is what makes §9's "auditable
 * by construction" claim true: there is no way to move an item without leaving
 * a trace, because the two writes cannot be separated.
 */
import { randomUUID } from "node:crypto";
import type { Db, SqlValue } from "./db.js";
import {
  ActionItem,
  type ActionItemContext,
  type ActionItemEvent,
  type ActionItemExecution,
  type ActionItemStatus,
  type Actor,
  type Priority,
  nowIso,
} from "../types/index.js";

export interface CreateActionItemInput {
  capability_id: string;
  type: string;
  context: ActionItemContext;
  custom: Record<string, unknown>;
  dedupe_key: string;
  responses: string[];
  execution: ActionItemExecution;
  priority?: Priority;
  deadline?: string | null;
  expires_at?: string | null;
  defer_until?: string | null;
}

export interface TransitionInput {
  id: string;
  to: ActionItemStatus;
  actor: Actor;
  reason?: string;
  /** Edit-then-approve, or a re-ingest superseding a draft (§5.1). */
  patch?: {
    context?: ActionItemContext;
    custom?: Record<string, unknown>;
    execution?: ActionItemExecution;
    priority?: Priority;
    deadline?: string | null;
    expires_at?: string | null;
    defer_until?: string | null;
  };
}

export interface ListFilter {
  status?: ActionItemStatus | ActionItemStatus[];
  capability_id?: string;
  priority?: Priority;
  type?: string;
  limit?: number;
  offset?: number;
}

/**
 * The action-item lifecycle. Anything not listed here is rejected, so an
 * impossible move (a rejected item quietly becoming executed, say) fails loudly
 * at the store rather than corrupting the audit trail downstream.
 */
const LEGAL_TRANSITIONS: Record<ActionItemStatus, readonly ActionItemStatus[]> = {
  // Escalated and waiting. Policy may approve it outright; Sandip may open,
  // reject, defer, or let the ttl sweep expire it.
  pending: ["in_review", "approved", "rejected", "deferred", "expired"],
  // Opened in the Inbox. Back to pending if a re-ingest supersedes what is on
  // screen (§5.1).
  in_review: ["approved", "rejected", "deferred", "pending", "expired"],
  // Handed to the Execution Registry. "staged" lands in awaiting_confirmation,
  // "succeeded" in executed, "failed" in failed (§5.3). Back to pending if a
  // re-ingest supersedes it before execution runs.
  approved: ["executed", "awaiting_confirmation", "failed", "pending"],
  // Dispatched but not committed. Closed by POST /confirm, sent back to the
  // Inbox by POST /reopen (§5.1).
  awaiting_confirmation: ["executed", "pending", "failed"],
  // Snoozed. Returns to the Inbox when its defer window elapses, but the
  // Deferred view can also act on it in place: "Act now" approves without
  // waiting and "Drop" discards it (UI-SPEC §5.3).
  deferred: ["pending", "in_review", "approved", "rejected", "expired"],
  // Retry re-approves with the same idempotency key; exhausted retries fall back
  // to guided, which stages and therefore awaits confirmation (§10).
  failed: ["approved", "awaiting_confirmation", "pending", "rejected"],
  rejected: [],
  executed: [],
  expired: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly id: string,
    readonly from: ActionItemStatus,
    readonly to: ActionItemStatus,
  ) {
    super(`action item ${id}: cannot transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class ActionItemNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`action item ${id} not found`);
    this.name = "ActionItemNotFoundError";
  }
}

export function canTransition(from: ActionItemStatus, to: ActionItemStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

interface ActionItemRow {
  id: string;
  capability_id: string;
  type: string;
  status: string;
  dedupe_key: string;
  priority: string;
  context_json: string;
  custom_json: string;
  responses_json: string;
  execution_json: string;
  deadline: string | null;
  expires_at: string | null;
  defer_until: string | null;
  created_at: string;
  updated_at: string;
}

function rowToActionItem(row: ActionItemRow): ActionItem {
  return ActionItem.parse({
    id: row.id,
    capability_id: row.capability_id,
    type: row.type,
    status: row.status,
    dedupe_key: row.dedupe_key,
    priority: row.priority,
    context: JSON.parse(row.context_json),
    custom: JSON.parse(row.custom_json),
    responses: JSON.parse(row.responses_json),
    execution: JSON.parse(row.execution_json),
    deadline: row.deadline,
    expires_at: row.expires_at,
    defer_until: row.defer_until,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

const SELECT = "SELECT * FROM action_items";

export function getActionItem(db: Db, id: string): ActionItem | undefined {
  const row = db.prepare<ActionItemRow>(`${SELECT} WHERE id = ?`).get(id);
  return row ? rowToActionItem(row) : undefined;
}

export function getActionItemByDedupeKey(
  db: Db,
  capabilityId: string,
  dedupeKey: string,
): ActionItem | undefined {
  const row = db
    .prepare<ActionItemRow>(`${SELECT} WHERE capability_id = ? AND dedupe_key = ?`)
    .get(capabilityId, dedupeKey);
  return row ? rowToActionItem(row) : undefined;
}

export function listActionItems(db: Db, filter: ListFilter = {}): ActionItem[] {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  // Normalised before the length check because an empty array is truthy, and
  // would otherwise build `status IN ()` and fail as a SQL syntax error rather
  // than reading as "no status filter".
  const statuses = filter.status
    ? Array.isArray(filter.status)
      ? filter.status
      : [filter.status]
    : [];
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (filter.capability_id) {
    clauses.push("capability_id = ?");
    params.push(filter.capability_id);
  }
  if (filter.priority) {
    clauses.push("priority = ?");
    params.push(filter.priority);
  }
  if (filter.type) {
    clauses.push("type = ?");
    params.push(filter.type);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  // Triage order (§12 step 23): urgent first, then within a priority the soonest
  // deadline (items without one sort after those that have one), then newest. The
  // CASE keeps priority semantic rather than alphabetical, which would put "high"
  // after "urgent" and "low" first; the NULL-guard keeps a missing deadline from
  // sorting ahead of a real one under SQLite's "NULLs are smallest" default.
  const order = `
    ORDER BY CASE priority
      WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      CASE WHEN deadline IS NULL THEN 1 ELSE 0 END, deadline ASC,
      created_at DESC`;
  params.push(filter.limit ?? 50, filter.offset ?? 0);

  return db
    .prepare<ActionItemRow>(`${SELECT}${where}${order} LIMIT ? OFFSET ?`)
    .all(...params)
    .map(rowToActionItem);
}

function appendEvent(
  db: Db,
  event: Omit<ActionItemEvent, "id" | "created_at"> & { created_at?: string },
): ActionItemEvent {
  const row: ActionItemEvent = {
    id: randomUUID(),
    created_at: event.created_at ?? nowIso(),
    action_item_id: event.action_item_id,
    from_status: event.from_status,
    to_status: event.to_status,
    actor: event.actor,
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.payload_diff !== undefined ? { payload_diff: event.payload_diff } : {}),
  };

  db.prepare(
    `INSERT INTO action_item_events
       (id, action_item_id, from_status, to_status, actor, reason, payload_diff_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.action_item_id,
    row.from_status,
    row.to_status,
    row.actor,
    row.reason ?? null,
    row.payload_diff ? JSON.stringify(row.payload_diff) : null,
    row.created_at,
  );

  return row;
}

/**
 * Records something that happened *to* an item without moving it.
 *
 * The rule at the top of this file still holds. `transition()` is the only way
 * to change a status, and this cannot change one: it reads both ends of the
 * event off the item itself, so the row it writes always has `from` equal to
 * `to`. That is how the trail records a deliberate decision to leave an item
 * alone, which is otherwise indistinguishable from nothing having happened.
 */
export function noteAgainstItem(
  db: Db,
  item: ActionItem,
  note: { actor: Actor; reason: string; payload_diff?: Record<string, unknown> },
): ActionItemEvent {
  return appendEvent(db, {
    action_item_id: item.id,
    from_status: item.status,
    to_status: item.status,
    actor: note.actor,
    reason: note.reason,
    ...(note.payload_diff !== undefined ? { payload_diff: note.payload_diff } : {}),
  });
}

/**
 * Inserts a new action item in `pending` and records the ingest event.
 *
 * Callers must be inside the ingest path (§5.1), which decides insert-versus-
 * upsert first. This function always inserts and will hit the
 * (capability_id, dedupe_key) unique constraint if that decision was skipped.
 */
export function createActionItem(
  db: Db,
  input: CreateActionItemInput,
  opts: { actor?: Actor; reason?: string } = {},
): ActionItem {
  const now = nowIso();
  const item: ActionItem = ActionItem.parse({
    id: randomUUID(),
    capability_id: input.capability_id,
    type: input.type,
    status: "pending" satisfies ActionItemStatus,
    dedupe_key: input.dedupe_key,
    priority: input.priority ?? "normal",
    context: input.context,
    custom: input.custom,
    responses: input.responses,
    execution: input.execution,
    deadline: input.deadline ?? null,
    expires_at: input.expires_at ?? null,
    defer_until: input.defer_until ?? null,
    created_at: now,
    updated_at: now,
  });

  return db.transaction(() => {
    db.prepare(
      `INSERT INTO action_items
         (id, capability_id, type, status, dedupe_key, priority, context_json,
          custom_json, responses_json, execution_json, deadline, expires_at,
          defer_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.id,
      item.capability_id,
      item.type,
      item.status,
      item.dedupe_key,
      item.priority,
      JSON.stringify(item.context),
      JSON.stringify(item.custom),
      JSON.stringify(item.responses),
      JSON.stringify(item.execution),
      item.deadline,
      item.expires_at,
      item.defer_until,
      item.created_at,
      item.updated_at,
    );

    appendEvent(db, {
      action_item_id: item.id,
      from_status: null,
      to_status: item.status,
      actor: opts.actor ?? "capability",
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      created_at: item.created_at,
    });

    return item;
  });
}

/** Shallow before/after diff of the fields a patch actually changed. */
function diffOf(
  before: ActionItem,
  patch: NonNullable<TransitionInput["patch"]>,
): Record<string, unknown> | undefined {
  const diff: Record<string, unknown> = {};
  for (const key of ["context", "custom", "execution", "priority"] as const) {
    const next = patch[key];
    if (next === undefined) continue;
    if (JSON.stringify(next) !== JSON.stringify(before[key])) {
      diff[key] = { from: before[key], to: next };
    }
  }
  return Object.keys(diff).length ? diff : undefined;
}

/**
 * Moves an action item to a new status, optionally patching its payload, and
 * appends the audit row for the move. The two writes share one transaction, so
 * a status change without a matching audit row is not representable.
 */
export function transition(db: Db, input: TransitionInput): ActionItem {
  return db.transaction(() => {
    const before = getActionItem(db, input.id);
    if (!before) throw new ActionItemNotFoundError(input.id);

    // A no-op re-entry (pending -> pending on re-ingest) is legitimate and is
    // still worth an audit row, but a genuinely illegal move is not.
    if (before.status !== input.to && !canTransition(before.status, input.to)) {
      throw new IllegalTransitionError(input.id, before.status, input.to);
    }

    const patch = input.patch ?? {};
    const next: ActionItem = ActionItem.parse({
      ...before,
      ...(patch.context !== undefined ? { context: patch.context } : {}),
      ...(patch.custom !== undefined ? { custom: patch.custom } : {}),
      ...(patch.execution !== undefined ? { execution: patch.execution } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.deadline !== undefined ? { deadline: patch.deadline } : {}),
      ...(patch.expires_at !== undefined ? { expires_at: patch.expires_at } : {}),
      // A resurface time only means anything while the item is snoozed. Clearing
      // it on the way out keeps a woken item from rendering a stale "returns at"
      // in the Inbox, and keeps the resurface sweep's index free of dead rows.
      defer_until:
        patch.defer_until !== undefined
          ? patch.defer_until
          : input.to === "deferred"
            ? before.defer_until
            : null,
      status: input.to,
      updated_at: nowIso(),
    });

    db.prepare(
      `UPDATE action_items
          SET status = ?, priority = ?, context_json = ?, custom_json = ?,
              execution_json = ?, deadline = ?, expires_at = ?, defer_until = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      next.status,
      next.priority,
      JSON.stringify(next.context),
      JSON.stringify(next.custom),
      JSON.stringify(next.execution),
      next.deadline,
      next.expires_at,
      next.defer_until,
      next.updated_at,
      next.id,
    );

    const payloadDiff = diffOf(before, patch);
    appendEvent(db, {
      action_item_id: next.id,
      from_status: before.status,
      to_status: next.status,
      actor: input.actor,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(payloadDiff !== undefined ? { payload_diff: payloadDiff } : {}),
      created_at: next.updated_at,
    });

    return next;
  });
}

interface EventRow {
  id: string;
  action_item_id: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  reason: string | null;
  payload_diff_json: string | null;
  created_at: string;
}

/** The full audit trail for one item, oldest first (GET /api/actions/:id/audit). */
export function listAuditTrail(db: Db, actionItemId: string): ActionItemEvent[] {
  return db
    .prepare<EventRow>(
      "SELECT * FROM action_item_events WHERE action_item_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(actionItemId)
    .map((row) => ({
      id: row.id,
      action_item_id: row.action_item_id,
      from_status: row.from_status as ActionItemEvent["from_status"],
      to_status: row.to_status as ActionItemStatus,
      actor: row.actor as Actor,
      ...(row.reason !== null ? { reason: row.reason } : {}),
      ...(row.payload_diff_json !== null
        ? { payload_diff: JSON.parse(row.payload_diff_json) as Record<string, unknown> }
        : {}),
      created_at: row.created_at,
    }));
}

/**
 * Frees a settled item's dedupe key so a genuine re-fire can insert a fresh row
 * under the original key (§5.1, branch 3). Callers must run this and the
 * following insert inside one transaction; a crash between them would otherwise
 * leave a rewritten key with no replacement row.
 */
export function releaseDedupeKey(db: Db, item: ActionItem): string {
  const superseded = `${item.dedupe_key}:superseded:${item.id}`;
  db.prepare("UPDATE action_items SET dedupe_key = ?, updated_at = ? WHERE id = ?").run(
    superseded,
    nowIso(),
    item.id,
  );
  return superseded;
}
