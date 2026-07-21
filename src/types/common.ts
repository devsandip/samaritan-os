/**
 * Shared enums and primitives (TECH-SPEC §4).
 *
 * Every contract in this folder is defined once as a zod schema and the
 * TypeScript type is inferred from it with `z.infer<>`, so the runtime validator
 * and the compile-time type can never drift apart. Nothing here declares a
 * standalone `interface`.
 */
import { z } from "zod";

export const RunMode = z.enum(["scheduled", "event", "manual", "continuous"]);
export type RunMode = z.infer<typeof RunMode>;

/**
 * What a scheduled trigger does about a fire it missed while the daemon was down
 * (§11). `skip` (the default) logs the miss and waits for the next occurrence;
 * `run_once` replays exactly one catch-up run, however many were missed, which
 * is what a daily or weekly digest wants.
 */
export const CatchUpMode = z.enum(["skip", "run_once"]);
export type CatchUpMode = z.infer<typeof CatchUpMode>;

export const RenderLayout = z.enum(["card", "form", "document", "diff"]);
export type RenderLayout = z.infer<typeof RenderLayout>;

export const ExecutionMode = z.enum(["guided", "assisted", "automated"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

export const ResponseOutcome = z.enum(["execute", "guided", "discard", "defer", "ask_more_info"]);
export type ResponseOutcome = z.infer<typeof ResponseOutcome>;

export const Priority = z.enum(["low", "normal", "high", "urgent"]);
export type Priority = z.infer<typeof Priority>;

export const ConnectionStatus = z.enum(["connected", "disconnected", "error", "not_configured"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const ActionItemStatus = z.enum([
  "pending",
  "in_review",
  "approved",
  // Dispatched (guided, or assisted needing an external commit) but not closed
  // out. Only POST /api/actions/:id/confirm moves it to executed. See §5.3.
  "awaiting_confirmation",
  "rejected",
  "deferred",
  "executed",
  "failed",
  "expired",
]);
export type ActionItemStatus = z.infer<typeof ActionItemStatus>;

/**
 * Statuses where the logical event has not yet run its course, so a re-ingest
 * may supersede the existing row rather than insert beside it (§5.1, branch 2).
 *
 * The test is whether the event is over, not whether anything external has
 * happened. Those are not the same question, and two members prove it:
 *
 * `deferred` belongs here despite being a decision Sandip made, because a
 * snoozed item is explicitly waiting to run its course. It does not roll back to
 * `pending` on supersede: the deferral says *when* he wants to look at this and
 * a re-ingest only says what the content is now, so the Action Center refreshes
 * the content and holds the window.
 *
 * `awaiting_confirmation` belongs here for the same reason, and is the one
 * member a re-ingest does not touch at all. Something external already exists by
 * then, a staged draft or an issued deep link, and `execution.payload` is the
 * only record of it. §5.1 branch 2a holds the row and records the re-emission
 * instead. Membership here is still right: the item is waiting on Sandip's hand,
 * so it has not run its course, and it must never be forked, because the row id
 * is the §10 idempotency key.
 */
export const UNSETTLED_STATUSES = [
  "pending",
  "in_review",
  "approved",
  "awaiting_confirmation",
  "deferred",
] as const satisfies readonly ActionItemStatus[];

/**
 * Statuses where the logical event already ran its course, so a re-ingest must
 * not mutate the row and instead inserts a fresh one (§5.1, branch 3).
 *
 * `failed` counts as run-its-course even though it is not terminal: execution
 * was attempted, so something external may already be half-committed and the
 * attempt is worth keeping as its own row.
 */
export const SETTLED_STATUSES = [
  "executed",
  "failed",
  "rejected",
  "expired",
] as const satisfies readonly ActionItemStatus[];

export function isSettled(status: ActionItemStatus): boolean {
  return (SETTLED_STATUSES as readonly ActionItemStatus[]).includes(status);
}

/** An ISO 8601 timestamp. Validated by parseability rather than by regex shape. */
export const IsoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 datetime");

/** Stable, kebab-case identifier. Used for capability ids and response ids. */
export const KebabId = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "must be kebab_or-kebab case");

/** Dotted execution-registry id, e.g. `notion.insight.create`. */
export const ExecutionCapabilityId = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/, "must be a dotted id like notion.insight.create");

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The one response every item accepts, whatever its manifest declares and
 * whether or not that manifest is still loaded (UI-SPEC §4.7).
 *
 * Without it, an item whose capability was unloaded after ingest has no response
 * the daemon can honour and is stuck in the Inbox forever, which breaks the
 * "everything lands in one inbox" promise at the only point that matters,
 * getting things back out of it.
 *
 * The colon is load-bearing. Response ids are `KebabId`, which has no colon, so
 * this is not a well-formed response id and no manifest can declare it. That
 * makes the reservation structural rather than a rule someone has to remember,
 * and it leaves plain `dismiss` free for capabilities that want it: the §4.6
 * newsletter example declares exactly that.
 */
export const DISMISS_RESPONSE_ID = "samaritan:dismiss";

/** Duration shorthand: a count and a unit, e.g. "24h", "30m", "1d". */
const DURATION = /^(\d+)\s*([smhd])$/;

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function isDuration(spec: string): boolean {
  return DURATION.test(spec.trim());
}

/**
 * Turns a duration shorthand into milliseconds. Shared by manifest `ttl` and
 * response `defer_for` so the two cannot drift into accepting different spellings
 * of the same thing.
 */
export function parseDuration(spec: string): number {
  const match = DURATION.exec(spec.trim());
  if (!match) throw new Error(`invalid duration "${spec}"; expected a form like "24h"`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}
