/**
 * The Inbox list row (UI-SPEC §6.1).
 *
 * Optimised for scanning a batch: lane tag and age on the top line, the headline
 * next, then the one-line "why", then the badges that carry the decision (mode,
 * deadline, confidence). Everything a correct item needs for a one-click approve
 * is on the row itself, so the detail pane is confirmation rather than discovery.
 */
import type { ActionItem } from "../api/types";
import type { ResolvedType } from "../lib/manifest";
import { itemTitle } from "../lib/manifest";
import { listBadges } from "../lib/badges";
import { laneOf, relativeTime } from "../lib/format";
import { Badge } from "./primitives";

export function ItemRow({
  item,
  resolved,
  active,
  onSelect,
}: {
  item: ActionItem;
  resolved: ResolvedType | undefined;
  active: boolean;
  onSelect: () => void;
}) {
  const lane = laneOf(item.context.source.kind);
  const laneClass = lane === "neutral" ? "src" : `src src-${lane}`;

  return (
    <button
      type="button"
      className={active ? "item active" : "item"}
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
    >
      <div className="item-top">
        <span className={laneClass}>{item.context.source.kind || item.capability_id}</span>
        <span className="time">{relativeTime(item.created_at)}</span>
      </div>
      <div className="item-title">{itemTitle(item, resolved)}</div>
      <div className="item-why">{item.context.why_flagged || item.context.decision_needed}</div>
      <div className="item-badges">
        {listBadges(item, resolved).map((badge, i) => (
          <Badge key={`${badge.label}-${i}`} spec={badge} />
        ))}
        {item.status === "awaiting_confirmation" ? (
          <Badge spec={{ label: "Awaiting your confirmation", variant: "assist" }} />
        ) : null}
        {item.status === "failed" ? (
          <Badge spec={{ label: "Execution failed", variant: "urgent" }} />
        ) : null}
      </div>
    </button>
  );
}
