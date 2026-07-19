/**
 * A client-side mirror of the store's legal-transition table
 * (`src/store/action-items.ts`), used only to decide whether a response button
 * can succeed right now.
 *
 * Without it, a deferred item would render its full button row and every click
 * would come back 409 from the server, which reads as a broken UI rather than a
 * lifecycle rule. The server stays the authority: this table only greys buttons
 * out and explains why, it never lets anything through that the server would
 * refuse.
 */
import type { ActionItemStatus, ResponseOutcome } from "../api/types";

const LEGAL: Record<ActionItemStatus, readonly ActionItemStatus[]> = {
  pending: ["in_review", "approved", "rejected", "deferred", "expired"],
  in_review: ["approved", "rejected", "deferred", "pending", "expired"],
  approved: ["executed", "awaiting_confirmation", "failed", "pending"],
  awaiting_confirmation: ["executed", "pending", "failed"],
  deferred: ["pending", "in_review", "expired"],
  failed: ["approved", "awaiting_confirmation", "pending", "rejected"],
  rejected: [],
  executed: [],
  expired: [],
};

/** What `ActionCenter.respond()` transitions to, per response outcome (§5.1). */
const TARGET: Record<ResponseOutcome, ActionItemStatus> = {
  execute: "approved",
  guided: "approved",
  discard: "rejected",
  defer: "deferred",
  ask_more_info: "in_review",
};

export function canTransition(from: ActionItemStatus, to: ActionItemStatus): boolean {
  return LEGAL[from].includes(to);
}

export function canRespond(status: ActionItemStatus, outcome: ResponseOutcome): boolean {
  return canTransition(status, TARGET[outcome]);
}

/** Plain-language reason a button is disabled. Shown as its title attribute. */
export function blockedReason(status: ActionItemStatus, outcome: ResponseOutcome): string {
  const target = TARGET[outcome];
  if (status === "deferred") {
    return `This item is deferred. It has to come back to the inbox before it can go to "${target}".`;
  }
  if (LEGAL[status].length === 0) {
    return `This item is ${status.replace(/_/g, " ")}. Nothing further can be done to it.`;
  }
  return `Not available while this item is ${status.replace(/_/g, " ")}.`;
}

/** Statuses that still want a decision from Sandip, so they belong in the Inbox. */
export const INBOX_STATUSES: ActionItemStatus[] = [
  "pending",
  "in_review",
  "awaiting_confirmation",
  "failed",
];

/** Statuses the Completed view records, newest first (§5.4). */
export const COMPLETED_STATUSES: ActionItemStatus[] = ["executed", "rejected", "expired"];
