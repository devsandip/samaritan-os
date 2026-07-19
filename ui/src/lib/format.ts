/** Display helpers. Nothing here talks to the API or holds state. */
import type { ActionItemStatus, ExecutionMode, Priority } from "../api/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2 days ago", "14 min ago". Absolute date once it is a week old. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;

  const delta = now - then;
  const future = delta < 0;
  const abs = Math.abs(delta);

  if (abs < MINUTE) return future ? "in a moment" : "just now";
  if (abs < HOUR) {
    const n = Math.round(abs / MINUTE);
    return future ? `in ${n} min` : `${n} min ago`;
  }
  if (abs < DAY) {
    const n = Math.round(abs / HOUR);
    return future ? `in ${n} hr` : `${n} hr ago`;
  }
  if (abs < 7 * DAY) {
    const n = Math.round(abs / DAY);
    const unit = n === 1 ? "day" : "days";
    return future ? `in ${n} ${unit}` : `${n} ${unit} ago`;
  }
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function fullTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Today" / "Yesterday" / a date, for the Completed day grouping (§5.4). */
export function dayLabel(iso: string, now = new Date()): string {
  const t = new Date(Date.parse(iso));
  if (Number.isNaN(t.getTime())) return "Unknown";

  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(t)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return t.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * §2.1 gives the four lanes a colour each. No v0 capability declares a lane, so
 * the item's own `context.source.kind` stands in: it is the closest thing the
 * OS contract has to "which part of Sandip's world is this from". Unknown kinds
 * get the neutral tag rather than a wrong colour.
 */
const LANE_BY_SOURCE: Record<string, string> = {
  session: "coding",
  wrap: "coding",
  repo: "coding",
  code: "coding",
  meeting: "work",
  transcript: "work",
  email: "work",
  slack: "work",
  calendar: "work",
  message: "personal",
  imessage: "personal",
  whatsapp: "personal",
  job: "job",
  application: "job",
};

export function laneOf(sourceKind: string): string {
  return LANE_BY_SOURCE[sourceKind.toLowerCase()] ?? "neutral";
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export const MODE_LABEL: Record<ExecutionMode, string> = {
  guided: "Guided",
  assisted: "Assisted",
  automated: "Automated",
};

export const STATUS_LABEL: Record<ActionItemStatus, string> = {
  pending: "Pending",
  in_review: "In review",
  approved: "Approved",
  awaiting_confirmation: "Awaiting your confirmation",
  rejected: "Rejected",
  deferred: "Deferred",
  executed: "Executed",
  failed: "Failed",
  expired: "Expired",
};

/** The Completed view's decision tag (§5.4) and its colour class. */
export function decisionTag(status: ActionItemStatus): { label: string; variant: string } {
  switch (status) {
    case "executed":
      return { label: "Done", variant: "appr" };
    case "rejected":
      return { label: "Dismissed", variant: "rej" };
    case "failed":
      return { label: "Failed", variant: "fail" };
    case "expired":
      return { label: "Expired", variant: "rej" };
    default:
      return { label: STATUS_LABEL[status], variant: "rej" };
  }
}

export const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/** Mirrors the server's ORDER BY so client-side merges keep the same shape. */
export function byPriorityThenNewest(
  a: { priority: Priority; created_at: string },
  b: { priority: Priority; created_at: string },
): number {
  const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (rank !== 0) return rank;
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

export function confidenceLabel(confidence: number): string {
  return `confidence ${confidence.toFixed(2)}`;
}

/** Renders an unknown JSON value as one readable line for the raw fallback (§4.7). */
export function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(renderScalar).join(", ");
  return JSON.stringify(value, null, 2);
}
