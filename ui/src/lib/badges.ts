/**
 * Badge derivation (UI-SPEC §4.6).
 *
 * One place decides what chips an item shows, because the list row and the
 * detail header must not disagree: the mode badge is always first, then the
 * OS-contract chips (deadline, priority, confidence), then whatever the
 * capability declared in `render.badges`, in declared order.
 */
import type { ActionItem, ExecutionMode } from "../api/types";
import type { ResolvedType } from "./manifest";
import { MODE_LABEL, confidenceLabel, renderScalar, titleCase } from "./format";

export type BadgeVariant = "neutral" | "guided" | "assist" | "auto" | "urgent";

export interface BadgeSpec {
  label: string;
  variant: BadgeVariant;
  title?: string;
}

const MODE_VARIANT: Record<ExecutionMode, BadgeVariant> = {
  guided: "guided",
  assisted: "assist",
  automated: "auto",
};

/** Hours before a deadline at which it starts reading as urgent. */
const ESCALATION_WINDOW_HOURS = 48;

export function modeBadge(item: ActionItem, resolved: ResolvedType | undefined): BadgeSpec {
  // The item's own execution.mode is the one that will actually run: routing
  // and §10's degrade already applied by the time it was persisted.
  const mode = item.execution.mode;
  const surface = item.context.execution_surface;
  const degraded = resolved?.degradedReason;
  return {
    label: surface ? `${MODE_LABEL[mode]} → ${surface}` : MODE_LABEL[mode],
    variant: MODE_VARIANT[mode],
    ...(degraded ? { title: `Degraded to guided: ${degraded}` } : {}),
  };
}

function deadlineBadge(item: ActionItem, now: number): BadgeSpec | undefined {
  if (!item.deadline) return undefined;
  const due = Date.parse(item.deadline);
  if (Number.isNaN(due)) return undefined;

  const hours = (due - now) / 3_600_000;
  const label =
    hours < 0
      ? `Overdue ${new Date(due).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
      : `Due ${new Date(due).toLocaleDateString(undefined, { weekday: "short" })}`;
  return { label, variant: hours <= ESCALATION_WINDOW_HOURS ? "urgent" : "neutral" };
}

/**
 * Full badge row for the detail header. The list row shows a truncated version
 * (see `listBadges`) so a row stays two lines tall.
 */
export function detailBadges(
  item: ActionItem,
  resolved: ResolvedType | undefined,
  now = Date.now(),
): BadgeSpec[] {
  const badges: BadgeSpec[] = [modeBadge(item, resolved)];

  const deadline = deadlineBadge(item, now);
  if (deadline) badges.push(deadline);

  if (item.priority === "urgent" || item.priority === "high") {
    badges.push({ label: titleCase(item.priority), variant: "urgent" });
  }

  badges.push({ label: confidenceLabel(item.context.confidence), variant: "neutral" });

  for (const field of resolved?.spec.render.badges ?? []) {
    const value = renderScalar(item.custom[field]);
    if (!value) continue;
    badges.push({ label: value, variant: "neutral", title: titleCase(field) });
  }

  return badges;
}

export function listBadges(
  item: ActionItem,
  resolved: ResolvedType | undefined,
  now = Date.now(),
): BadgeSpec[] {
  return detailBadges(item, resolved, now).slice(0, 4);
}
