/**
 * Action Center service (TECH-SPEC §2.2, §5.1, §5.3, §12 step 6).
 *
 * The universal inbox and the owner of the action-item lifecycle end to end:
 * ingest, triage, decide, execute, confirm, fail, expire, audit. Everything that
 * changes an item's status goes through here and through the store's
 * `transition()`, so the audit trail is complete by construction.
 */
import { log } from "../logger.js";
import { evaluate, type PolicyDecision } from "../policy/index.js";
import type { CapabilityRegistry, LoadedType } from "../registry/index.js";
import type { RoutingResolver } from "../routing/index.js";
import type { Registry as ExecutionRegistry } from "../execution/registry.js";
import {
  createActionItem,
  getActionItem,
  getActionItemByDedupeKey,
  listActionItems,
  noteAgainstItem,
  releaseDedupeKey,
  transition,
} from "../store/action-items.js";
import type { Db } from "../store/db.js";
import {
  DISMISS_RESPONSE_ID,
  DraftActionItem,
  isSettled,
  parseDuration,
  type ActionItem,
  type ActionItemExecution,
  type Actor,
  type ExecutionMode,
} from "../types/index.js";
import { isWithinQuietHours, parseQuietHours, quietHoursEnd } from "../delivery/quiet-hours.js";

const logger = log("action-center");

export interface IngestAccepted {
  id: string;
  dedupe_key: string;
  status: ActionItem["status"];
  policy: PolicyDecision;
}

export interface IngestRejected {
  item: unknown;
  errors: string[];
}

export interface IngestResult {
  accepted: IngestAccepted[];
  rejected: IngestRejected[];
}

export interface Delivery {
  notify(item: ActionItem): Promise<void>;
}

export interface ActionCenterDeps {
  db: Db;
  capabilities: CapabilityRegistry;
  execution: ExecutionRegistry;
  routing: RoutingResolver;
  delivery?: Delivery;
  /**
   * e.g. "22:00-07:00". Snoozes that would land inside the window are pushed to
   * the moment it opens, so a resurfaced item is never one Sandip sleeps through
   * (UI-SPEC §5.3). Omitted means no window and no adjustment.
   */
  quietHours?: string;
}

export class ActionCenterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ActionCenterError";
  }
}

/** How much autonomy each mode carries. Guided is the floor (§1). */
const MODE_RANK: Record<ExecutionMode, number> = { guided: 0, assisted: 1, automated: 2 };

export class ActionCenter {
  constructor(private readonly deps: ActionCenterDeps) {}

  /**
   * §5.1. Validates each draft against its manifest, resolves the upsert, runs
   * the Policy Engine and either auto-completes or escalates.
   *
   * One bad draft never fails the batch: it lands in `rejected[]` with its
   * errors while the rest proceed. A capability that drifts from its manifest
   * should degrade, not take down the whole run.
   */
  async ingest(capabilityId: string, drafts: unknown[]): Promise<IngestResult> {
    const accepted: IngestAccepted[] = [];
    const rejected: IngestRejected[] = [];

    const capability = this.deps.capabilities.get(capabilityId);
    if (!capability) {
      return {
        accepted: [],
        rejected: drafts.map((item) => ({
          item,
          errors: [`unknown capability "${capabilityId}"`],
        })),
      };
    }

    for (const raw of drafts) {
      const withCapability =
        typeof raw === "object" && raw !== null
          ? { capability_id: capabilityId, ...(raw as Record<string, unknown>) }
          : raw;

      const parsed = DraftActionItem.safeParse(withCapability);
      if (!parsed.success) {
        rejected.push({
          item: raw,
          errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        continue;
      }
      const draft = parsed.data;

      const loadedType = capability.types.get(draft.type);
      if (!loadedType) {
        rejected.push({
          item: raw,
          errors: [
            `"${draft.type}" is not an action-item type emitted by "${capabilityId}" ` +
              `(declared: ${[...capability.types.keys()].join(", ")})`,
          ],
        });
        continue;
      }

      const custom = loadedType.customSchema.safeParse(draft.custom);
      if (!custom.success) {
        rejected.push({
          item: raw,
          errors: custom.error.issues.map((i) => `custom.${i.path.join(".")}: ${i.message}`),
        });
        continue;
      }
      draft.custom = custom.data;

      try {
        accepted.push(await this.#ingestOne(draft, loadedType));
      } catch (err) {
        rejected.push({ item: raw, errors: [(err as Error).message] });
      }
    }

    return { accepted, rejected };
  }

  /**
   * The mode this item will actually run in, resolved at ingest so the Inbox
   * can say so before Sandip decides.
   *
   * `type.effectiveMode` is the manifest's mode after §10's missing-adapter
   * degradation, and it is not the whole answer: when a type declares an
   * `action_type`, Routing decides the mode and `execute()` re-resolves it at
   * dispatch. Storing the manifest's mode meant a money-locked renewal was
   * shown as "Automated → on approve, this is filed directly" — on the one
   * item in the system that can never be automated. The card was promising
   * exactly what §9 exists to refuse.
   *
   * This is a preview, not a decision: `execute()` resolves again at dispatch,
   * so a routing change between ingest and approval still wins.
   */
  #previewMode(type: LoadedType): ExecutionMode {
    const actionType = type.spec.execution.action_type;
    if (!actionType) return type.effectiveMode;

    try {
      const resolved = this.deps.routing.resolve(actionType, {
        declaredExecutionCapabilityId: type.spec.execution.capability,
      });
      // Never above the manifest's own ceiling: routing choosing a freer mode
      // than the capability asked for would be a promotion nobody authored.
      return MODE_RANK[resolved.mode] < MODE_RANK[type.effectiveMode]
        ? resolved.mode
        : type.effectiveMode;
    } catch {
      // No routing entry for this action type. execute() has the same fallback.
      return type.effectiveMode;
    }
  }

  async #ingestOne(draft: DraftActionItem, type: LoadedType): Promise<IngestAccepted> {
    const { db } = this.deps;

    const decision = evaluate(draft, type.spec.policy, {
      executionCapabilityId: type.spec.execution.capability,
      ...(type.spec.execution.action_type ? { actionType: type.spec.execution.action_type } : {}),
    });

    // The `custom` payload doubles as the execution payload: a capability
    // declares the attributes its execution target needs, so the manifest is
    // the single place the two shapes are kept in agreement.
    const execution: ActionItemExecution = {
      mode: this.#previewMode(type),
      capability: type.spec.execution.capability,
      payload: draft.custom,
    };

    const existing = getActionItemByDedupeKey(db, draft.capability_id, draft.dedupe_key);

    let item: ActionItem;
    if (!existing) {
      // Branch 1: ordinary insert.
      item = createActionItem(db, {
        capability_id: draft.capability_id,
        type: draft.type,
        context: draft.context,
        custom: draft.custom,
        dedupe_key: draft.dedupe_key,
        responses: type.spec.responses.map((r) => r.id),
        execution,
        priority: type.spec.priority,
        expires_at: expiresAt(type.spec.ttl),
      });
    } else if (existing.status === "awaiting_confirmation") {
      // Branch 2a: already dispatched. The row is left byte-identical and only
      // the re-emission is recorded.
      //
      // Neither of the other two branches is safe here. Superseding in place
      // rolls the status back to pending, which overwrites `execution` and takes
      // `_guided_link` with it: that link is the only record of what the OS put
      // in the world, there is no way to un-issue it, and `confirm()`/`reopen()`
      // both refuse anything that is not awaiting_confirmation, so the item is
      // left with no way to close its own loop. Forking a fresh row instead
      // mints a new id, and the id *is* the idempotency key (§10), so the next
      // approve would miss the registry's replay guard and dispatch a second
      // time for real.
      //
      // So the refreshed content waits. The OS has already handed Sandip
      // something and cannot take it back; stacking a revision on top of an
      // unanswered handoff would make the amber chip claim "we staged X" over
      // content that now reads X'. "Didn't do it" (`POST /reopen`) is how he
      // says the handoff is void, and the next re-ingest lands normally.
      // Same {slot: {from, to}} shape every other event uses. The trail's
      // renderer probes `slot.from`, so a bare value stores the withheld
      // revision in a form the one surface built to read it cannot.
      const withheld: Record<string, unknown> = {};
      if (JSON.stringify(draft.context) !== JSON.stringify(existing.context)) {
        withheld["context"] = { from: existing.context, to: draft.context };
      }
      if (JSON.stringify(draft.custom) !== JSON.stringify(existing.custom)) {
        withheld["custom"] = { from: existing.custom, to: draft.custom };
      }
      noteAgainstItem(db, existing, {
        actor: "capability",
        reason: "reingest_held_awaiting_confirmation",
        // A re-emission of identical content is a no-op worth recording as one,
        // matching branch 2, which writes no diff when nothing changed.
        ...(Object.keys(withheld).length ? { payload_diff: withheld } : {}),
      });
      logger.info(
        { id: existing.id, type: existing.type },
        "held a dispatched item against re-ingest",
      );
      return {
        id: existing.id,
        dedupe_key: draft.dedupe_key,
        status: existing.status,
        policy: decision,
      };
    } else if (!isSettled(existing.status)) {
      // Branch 2: nothing external has been committed, so the stale draft is
      // superseded in place. Whatever Sandip was reviewing no longer matches the
      // content, so review state rolls back to pending and policy re-runs.
      //
      // A snoozed row is the exception: it stays snoozed, for the window it
      // already had. Deferring is a decision about *when* to look at this and a
      // re-ingest only says what the content is now, so refreshing the content
      // and holding the window honours both. Rolling it back to pending would
      // let any capability that re-emits on every run cancel the snooze, and
      // forking a fresh row instead leaves the old one to resurface as a
      // duplicate. Policy still runs below, so a refresh that now auto-completes
      // executes without waiting, which is the way through for something that
      // has become urgent.
      const staysDeferred = existing.status === "deferred";
      item = transition(db, {
        id: existing.id,
        to: staysDeferred ? "deferred" : "pending",
        actor: "capability",
        reason: "superseded_by_reingest",
        patch: { context: draft.context, custom: draft.custom, execution },
      });
    } else {
      // Branch 3: the logical event already ran its course, so it must not be
      // mutated. Free its key and insert a fresh row under the original, both
      // inside one transaction so a crash cannot leave a rewritten key with no
      // replacement row.
      item = db.transaction(() => {
        releaseDedupeKey(db, existing);
        return createActionItem(db, {
          capability_id: draft.capability_id,
          type: draft.type,
          context: draft.context,
          custom: draft.custom,
          dedupe_key: draft.dedupe_key,
          responses: type.spec.responses.map((r) => r.id),
          execution,
          priority: type.spec.priority,
          expires_at: expiresAt(type.spec.ttl),
        });
      });
    }

    if (decision.outcome === "auto_complete") {
      const approved = transition(db, {
        id: item.id,
        to: "approved",
        actor: "policy",
        reason: decision.reason,
      });
      item = await this.execute(approved);
    } else if (item.status === "deferred") {
      // Refreshed in place but still snoozed, so it is not in the Inbox and must
      // not ping: notifying here would defeat the snooze through the side door.
      // resurface() delivers when the window actually elapses.
      logger.info(
        { id: item.id, type: item.type, defer_until: item.defer_until },
        "refreshed a snoozed item in place",
      );
    } else {
      logger.info(
        { id: item.id, type: item.type, rule: decision.matched_rule },
        "escalated to the inbox",
      );
      await this.deps.delivery?.notify(item).catch((err: unknown) => {
        // Delivery is a side channel. A Telegram outage must not lose an item
        // that is already durably in the Inbox.
        logger.warn({ id: item.id, err: String(err) }, "delivery failed");
      });
    }

    return {
      id: item.id,
      dedupe_key: draft.dedupe_key,
      status: item.status,
      policy: decision,
    };
  }

  /**
   * Resolves the concrete execution target for an approved item and dispatches
   * it, mapping the result onto the lifecycle per §5.3.
   */
  async execute(item: ActionItem): Promise<ActionItem> {
    const { db, execution: registry, routing } = this.deps;

    let mode: ExecutionMode = item.execution.mode;
    let capabilityId = item.execution.capability;

    const type = this.deps.capabilities.getType(item.capability_id, item.type);
    const actionType = type?.spec.execution.action_type;
    if (actionType) {
      try {
        const resolved = routing.resolve(actionType, {
          declaredExecutionCapabilityId: capabilityId,
        });
        mode = resolved.mode;
        capabilityId = resolved.execution_capability_id;
      } catch (err) {
        logger.warn(
          { id: item.id, actionType, err: (err as Error).message },
          "routing failed; falling back to the manifest's declared target",
        );
      }
    }

    // §1: nothing is allowed to have no fallback. An adapter that is missing, or
    // that cannot do the resolved mode, drops to the guided floor rather than
    // failing the item outright.
    const adapter = registry.get(capabilityId);
    if (!adapter || !adapter.modes.includes(mode)) {
      logger.warn(
        { id: item.id, capabilityId, mode, registered: Boolean(adapter) },
        "degrading to guided.fallback",
      );
      capabilityId = "guided.fallback";
      mode = "guided";
    }

    const result = await registry.execute({
      action_item_id: item.id,
      capability: capabilityId,
      mode,
      payload: item.execution.payload,
      idempotency_key: dispatchKey(db, item),
    });

    if (result.status === "succeeded") {
      return transition(db, {
        id: item.id,
        to: "executed",
        actor: "system",
        reason: `${capabilityId} succeeded`,
      });
    }

    if (result.status === "staged") {
      // §5.3: the OS has done its part but the real-world effect is not
      // committed. Only Sandip's confirm closes it out.
      return transition(db, {
        id: item.id,
        to: "awaiting_confirmation",
        actor: "system",
        reason: result.guided_link
          ? `${capabilityId} staged: ${result.guided_link}`
          : `${capabilityId} staged`,
        patch: {
          execution: {
            ...item.execution,
            mode,
            capability: capabilityId,
            payload: {
              ...item.execution.payload,
              ...(result.guided_link ? { _guided_link: result.guided_link } : {}),
              ...(result.guided_instructions
                ? { _guided_instructions: result.guided_instructions }
                : {}),
            },
          },
        },
      });
    }

    return transition(db, {
      id: item.id,
      to: "failed",
      actor: "system",
      reason: result.error ?? `${capabilityId} failed`,
    });
  }

  /** POST /api/actions/:id/respond. Enforces the item's allowed responses. */
  async respond(
    id: string,
    input: { response_id: string; edited_payload?: Record<string, unknown>; actor?: Actor },
  ): Promise<ActionItem> {
    const { db } = this.deps;
    const item = this.#require(id);

    // §4.7's universal fallback, answered before either manifest check below.
    // Both of those ask what the capability declares, and the case this exists
    // for is the one where it declares nothing any more. Discarding is the only
    // outcome that is safe to honour without a manifest: it commits nothing, so
    // there is no payload to get wrong and no side effect to guess at.
    if (input.response_id === DISMISS_RESPONSE_ID) {
      return transition(db, {
        id,
        to: "rejected",
        actor: input.actor ?? "sandip",
        reason: "dismissed",
      });
    }

    if (!item.responses.includes(input.response_id)) {
      throw new ActionCenterError(
        `"${input.response_id}" is not an allowed response for this item ` +
          `(allowed: ${[...item.responses, DISMISS_RESPONSE_ID].join(", ")})`,
        "response_not_allowed",
        400,
      );
    }

    const type = this.deps.capabilities.getType(item.capability_id, item.type);
    const response = type?.spec.responses.find((r) => r.id === input.response_id);
    if (!response) {
      throw new ActionCenterError(
        `response "${input.response_id}" is no longer declared by the manifest; ` +
          `restore capability "${item.capability_id}" to answer it, ` +
          `or "${DISMISS_RESPONSE_ID}" to clear the item`,
        "response_unknown",
        409,
      );
    }

    const actor: Actor = input.actor ?? "sandip";
    const patch = input.edited_payload
      ? {
          custom: input.edited_payload,
          execution: { ...item.execution, payload: input.edited_payload },
        }
      : undefined;

    switch (response.outcome) {
      case "execute":
      case "guided": {
        const approved = transition(db, {
          id,
          to: "approved",
          actor,
          reason: `responded: ${response.id}`,
          ...(patch ? { patch } : {}),
        });
        return this.execute(approved);
      }
      case "discard":
        return transition(db, { id, to: "rejected", actor, reason: `responded: ${response.id}` });
      case "defer":
        return transition(db, {
          id,
          to: "deferred",
          actor,
          reason: `responded: ${response.id}`,
          patch: {
            ...(patch ?? {}),
            defer_until: deferUntil(response.defer_for, this.deps.quietHours),
          },
        });
      case "ask_more_info":
        return transition(db, {
          id,
          to: "in_review",
          actor,
          reason: `responded: ${response.id}`,
          ...(patch ? { patch } : {}),
        });
    }
  }

  /** POST /api/actions/:id/confirm. Only valid from awaiting_confirmation (§5.1). */
  confirm(id: string, input: { actor?: Actor; note?: string } = {}): ActionItem {
    const item = this.#require(id);
    if (item.status !== "awaiting_confirmation") {
      throw new ActionCenterError(
        `item is ${item.status}, not awaiting_confirmation`,
        "not_awaiting_confirmation",
        409,
      );
    }
    return transition(this.deps.db, {
      id,
      to: "executed",
      actor: input.actor ?? "sandip",
      reason: input.note ?? "confirmed by hand",
    });
  }

  /** POST /api/actions/:id/reopen. The "didn't do it" path (§5.1). */
  reopen(id: string, input: { actor?: Actor; reason?: string } = {}): ActionItem {
    const item = this.#require(id);
    if (item.status !== "awaiting_confirmation") {
      throw new ActionCenterError(
        `item is ${item.status}, not awaiting_confirmation`,
        "not_awaiting_confirmation",
        409,
      );
    }
    return transition(this.deps.db, {
      id,
      to: "pending",
      actor: input.actor ?? "sandip",
      reason: input.reason ?? "reopened",
    });
  }

  /** Marks expired anything past its ttl. Returns how many were swept. */
  expire(now = new Date()): number {
    const { db } = this.deps;
    const due = db
      .prepare<{ id: string }>(
        `SELECT id FROM action_items
          WHERE expires_at IS NOT NULL AND expires_at <= ?
            AND status IN ('pending', 'in_review', 'deferred')`,
      )
      .all(now.toISOString());

    for (const { id } of due) {
      transition(db, { id, to: "expired", actor: "system", reason: "ttl elapsed" });
    }
    return due.length;
  }

  /**
   * Returns snoozed items to the Inbox once their defer window elapses, and
   * re-notifies. Without this a defer was a one-way door: `deferred` had no
   * resurface time and nothing swept it, so "Snooze 1 day" meant "discard
   * quietly". Returns how many woke.
   *
   * Run `expire()` first if you run both: an item past both its ttl and its
   * snooze should expire rather than briefly reappear.
   */
  async resurface(now = new Date()): Promise<number> {
    const { db } = this.deps;
    const due = db
      .prepare<{ id: string }>(
        `SELECT id FROM action_items
          WHERE status = 'deferred' AND defer_until IS NOT NULL AND defer_until <= ?
          ORDER BY defer_until ASC`,
      )
      .all(now.toISOString());

    for (const { id } of due) {
      const item = transition(db, {
        id,
        to: "pending",
        actor: "system",
        reason: "defer window elapsed",
      });
      logger.info({ id, type: item.type }, "resurfaced from deferred");
      // Same side-channel treatment as escalation: a notification failure must
      // not undo a wake that is already committed.
      await this.deps.delivery?.notify(item).catch((err: unknown) => {
        logger.warn({ id, err: String(err) }, "delivery failed");
      });
    }
    return due.length;
  }

  /**
   * Boot reconciliation (§11). Recovers items a crash caught mid-handoff and
   * returns how many were re-driven.
   *
   * `approved` is the instant an item is with the Execution Registry but its
   * outcome is not yet recorded: `execute()` transitions to `approved`, awaits
   * the adapter, then transitions to executed/awaiting_confirmation/failed. A
   * process that dies in that await strands the item in `approved` — not in the
   * Inbox (approved is not a reviewable state) and with nothing to move it, so
   * without this it is lost. Re-running `execute()` is the recovery, and it is
   * safe by construction because `dispatchKey` is derived deterministically from
   * the item and its reopen count: a re-drive reuses the original key, so an
   * attempt that already settled replays its recorded result (no second external
   * effect) and one that never settled runs once more. That is exactly §5.3's
   * retry-after-timeout guarantee, applied to a restart instead of a timeout.
   *
   * Must run while nothing else dispatches — before the socket opens and before
   * the scheduler and listeners start. Only then is every `approved` item a
   * genuine remnant rather than one a live `respond()` is mid-`execute()` on, and
   * only then is `reconcileStalePending()` safe to fail every pending row.
   */
  async reconcile(): Promise<number> {
    const { db, execution: registry } = this.deps;
    // Correct the ledger first: fail the pending execution rows the same crash
    // left behind, so the re-drive below opens a clean attempt rather than
    // stacking on one that claims to still be running.
    const failedRows = registry.reconcileStalePending();

    const stranded = listActionItems(db, { status: "approved", limit: 500 });
    for (const item of stranded) {
      logger.info({ id: item.id, type: item.type }, "re-driving an item interrupted mid-execution");
      try {
        await this.execute(item);
      } catch (err) {
        // One item's recovery failing must not abort the boot pass or block the
        // rest. It stays `approved`; the next restart tries it again.
        logger.error({ id: item.id, err: String(err) }, "reconcile: re-drive failed");
      }
    }

    if (failedRows || stranded.length) {
      logger.info(
        { failed_executions: failedRows, redriven: stranded.length },
        "reconciled interrupted work on boot",
      );
    }
    return stranded.length;
  }

  #require(id: string): ActionItem {
    const item = getActionItem(this.deps.db, id);
    if (!item) throw new ActionCenterError(`action item ${id} not found`, "not_found", 404);
    return item;
  }
}

/** Turns a manifest ttl like "24h" into an absolute expiry. */
export function expiresAt(ttl: string | null, from = new Date()): string | null {
  if (!ttl) return null;
  return new Date(from.getTime() + parseDuration(ttl)).toISOString();
}

/**
 * How long a defer response snoozes for when its manifest does not say. A day
 * matches the label the shipped capabilities use ("Snooze 1 day").
 */
/**
 * The idempotency key for dispatching this item (§10).
 *
 * The item id alone over-scopes it. §10 wants a key stable across *retries of
 * the same approval*, and the id is stable for the item's entire life, so once
 * an approval has staged, the registry replays that attempt forever and a
 * genuinely different version of the same item can never be dispatched at all.
 * That turns "Didn't do it, here is the revised version" into a card showing the
 * new content over instructions for the old, which is worse than refusing it.
 *
 * So the key carries a generation: how many times a dispatch on this item has
 * been declared void. `POST /reopen` is the only thing that says so, and it is
 * Sandip saying it by hand. A retry after a failure does not bump it, because
 * that genuinely is the same approval, which is the case the guard exists for.
 */
export function dispatchKey(db: Db, item: ActionItem): string {
  const row = db
    .prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM action_item_events
        WHERE action_item_id = ?
          AND from_status = 'awaiting_confirmation' AND to_status = 'pending'`,
    )
    .get(item.id);
  return `${item.id}:${row?.n ?? 0}`;
}

export const DEFAULT_DEFER_FOR = "1d";

/**
 * Turns a response's `defer_for` into the absolute moment the item comes back,
 * skipping quiet hours. A 2 AM snooze on a "22:00-07:00" window resolves to 7 AM
 * rather than waking to a notification nobody reads (UI-SPEC §5.3).
 */
export function deferUntil(
  deferFor: string | undefined,
  quietHours: string | undefined,
  from = new Date(),
): string {
  const at = new Date(from.getTime() + parseDuration(deferFor ?? DEFAULT_DEFER_FOR));
  if (!quietHours) return at.toISOString();

  const window = parseQuietHours(quietHours);
  return isWithinQuietHours(at, window) ? quietHoursEnd(at, window).toISOString() : at.toISOString();
}
