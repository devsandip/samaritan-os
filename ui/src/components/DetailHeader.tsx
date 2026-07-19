/**
 * The shared chrome every layout assembles (UI-SPEC §4.3, steps 1-4).
 *
 * All four parts read OS-contract fields the Action Center owns, never capability
 * data, which is why §4.7 can still render the header when the body falls back
 * to raw JSON.
 */
import type { ActionItem } from "../api/types";
import type { ResolvedType } from "../lib/manifest";
import { detailBadges } from "../lib/badges";
import { STATUS_LABEL } from "../lib/format";
import { Badge } from "./primitives";

const STATUS_BADGE: Partial<Record<ActionItem["status"], string>> = {
  awaiting_confirmation: "assist",
  failed: "urgent",
  executed: "auto",
  expired: "urgent",
};

function triggerLine(resolved: ResolvedType | undefined): string {
  const trigger = resolved?.capability.trigger;
  if (!trigger) return "";
  const detail =
    trigger.cron ?? trigger.on?.join(", ") ?? trigger.command ?? undefined;
  return detail ? `trigger: ${trigger.mode} (${detail})` : `trigger: ${trigger.mode}`;
}

export function DetailHeader({
  item,
  resolved,
  title,
}: {
  item: ActionItem;
  resolved: ResolvedType | undefined;
  /** The live draft title, so an edit shows up in the header as it is typed. */
  title: string;
}) {
  const source = item.context.source;
  const parts = [
    item.capability_id,
    triggerLine(resolved),
    `source: ${source.kind}${source.id ? ` (${source.id})` : ""}`,
    item.context.execution_surface ? `files to: ${item.context.execution_surface}` : "",
  ].filter(Boolean);

  return (
    <>
      <div className="d-src">
        {parts.join(" · ")}
        {source.link ? (
          <>
            {" · "}
            <a href={source.link} target="_blank" rel="noreferrer">
              open source
            </a>
          </>
        ) : null}
      </div>

      <h1 className="d-title">{title}</h1>

      <div className="d-meta">
        {detailBadges(item, resolved).map((badge, i) => (
          <Badge key={`${badge.label}-${i}`} spec={badge} />
        ))}
        {/* §4.8: awaiting confirmation is amber, not neutral. It is a state that
            still wants something from Sandip, and it has to read differently
            from a fresh item at a glance. */}
        {item.status !== "pending" ? (
          <span className={`badge ${STATUS_BADGE[item.status] ?? ""}`.trim()}>
            {STATUS_LABEL[item.status]}
          </span>
        ) : null}
      </div>

      <div className="d-why">
        <b>Why you&apos;re seeing this:</b> {item.context.why_flagged || item.context.what_happened}
        {item.context.decision_needed ? (
          <>
            <br />
            <b>Decision needed:</b> {item.context.decision_needed}
          </>
        ) : null}
      </div>
    </>
  );
}
