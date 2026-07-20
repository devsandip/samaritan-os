/**
 * The per-item audit trail (TECH-SPEC §4.5, UI-SPEC §5.4).
 *
 * This is the trust surface: it is how Sandip answers "why is this row in
 * Notion" months later, so every event is rendered as a sentence with an actor
 * and a reason rather than as a status pair. The server's `reason` strings are
 * machine-shaped (`responded: approve`, `pm-os.item.file staged: ...`), so they
 * are translated here; the raw string is kept as the title attribute so nothing
 * is hidden.
 */
import type { ActionItemEvent, Actor } from "../api/types";
import { fullTimestamp, titleCase } from "../lib/format";
import { changedFields } from "../lib/payload";

const ACTOR_LABEL: Record<Actor, string> = {
  sandip: "You",
  policy: "The policy engine",
  system: "Samaritan",
  capability: "The capability",
};

const TERMINAL = new Set(["executed", "rejected", "expired"]);
const PROBLEM = new Set(["failed"]);

/** Turns a transition into a sentence. Falls back to the status pair. */
function headline(event: ActionItemEvent): string {
  const actor = ACTOR_LABEL[event.actor];

  // An event that does not move the item is not a transition, so the table
  // below would mislabel it: a held re-ingest against a dispatched row would
  // read "Samaritan staged it", claiming a second dispatch that never happened.
  if (event.from_status !== null && event.from_status === event.to_status) {
    if (event.reason === "reingest_held_awaiting_confirmation") {
      return `${actor} re-sent this, and it was left as it is`;
    }
    return `${actor} touched this without changing its state`;
  }

  switch (event.to_status) {
    case "pending":
      return event.from_status === null
        ? `${actor} escalated this to the inbox`
        : `${actor} sent this back to the inbox`;
    case "in_review":
      return `${actor} opened this for review`;
    case "approved":
      return `${actor} approved it`;
    case "awaiting_confirmation":
      return "Samaritan staged it and is waiting on you";
    case "executed":
      return event.actor === "sandip" ? "You confirmed it was done" : "It executed";
    case "rejected":
      return `${actor} discarded it`;
    case "deferred":
      return `${actor} deferred it`;
    case "failed":
      return "Execution failed";
    case "expired":
      return "It expired before anyone acted";
    default:
      return `${actor} moved it to ${event.to_status}`;
  }
}

/** `responded: approve` and friends read badly in a trail. */
function reasonText(event: ActionItemEvent): string | undefined {
  const reason = event.reason?.trim();
  if (!reason) return undefined;

  const responded = /^responded:\s*(.+)$/.exec(reason);
  if (responded?.[1]) return `Response: ${titleCase(responded[1])}`;
  if (reason === "superseded_by_reingest") {
    return "The capability re-sent this item, so the earlier draft was replaced.";
  }
  if (reason === "reingest_held_awaiting_confirmation") {
    return (
      "The capability re-sent this item with newer content. Samaritan had already " +
      "staged the version above, so the item was left exactly as it is rather " +
      'than overwritten. If that handoff is void, press "Didn\'t do it": the ' +
      "newer content lands the next time the capability runs, and approving it " +
      "then stages it for real rather than pointing you back at this one."
    );
  }
  if (reason === "confirmed by hand") return undefined;
  return reason;
}

/**
 * `payload_diff` is keyed by the patched top-level slot (`custom`, `execution`,
 * ...), each `{from, to}`. Those names mean nothing to a reader, and `execution`
 * changes on every edit as a side effect of the payload swap. What matters is
 * which *attributes* moved, so the custom slot is diffed down to field names and
 * the rest is summarized.
 */
function describeDiff(diff: Record<string, unknown>): string | undefined {
  const slot = diff["custom"] as { from?: unknown; to?: unknown } | undefined;
  if (slot && typeof slot.from === "object" && typeof slot.to === "object") {
    const fields = changedFields(
      (slot.from ?? {}) as Record<string, unknown>,
      (slot.to ?? {}) as Record<string, unknown>,
    );
    if (fields.length) return `Edited before filing: ${fields.map(titleCase).join(", ")}`;
  }
  if (diff["execution"]) return "Execution target was resolved";
  if (diff["context"]) return "The capability re-sent this with new context";
  return undefined;
}

export function AuditTrail({
  events,
  itemCreatedAt,
}: {
  events: ActionItemEvent[];
  itemCreatedAt: string;
}) {
  if (events.length === 0) {
    return (
      <div className="empty left">
        No recorded transitions yet. This item was created {fullTimestamp(itemCreatedAt)}.
      </div>
    );
  }

  const ordered = [...events].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  return (
    <div className="audit">
      {ordered.map((event) => {
        const changed = event.payload_diff ? describeDiff(event.payload_diff) : undefined;
        const cls = TERMINAL.has(event.to_status)
          ? "arow terminal"
          : PROBLEM.has(event.to_status)
            ? "arow problem"
            : "arow";
        const reason = reasonText(event);

        return (
          <div className={cls} key={event.id}>
            <div className="headline">
              <span className="who">{headline(event)}</span>{" "}
              <span className="from">
                {event.from_status === null
                  ? `(new → ${event.to_status})`
                  : event.from_status === event.to_status
                    ? // Not a move, so an arrow pointing at itself is noise.
                      `(${event.to_status}, unchanged)`
                    : `(${event.from_status} → ${event.to_status})`}
              </span>
            </div>
            <div className="sub">
              {fullTimestamp(event.created_at)}
              {reason ? ` · ${reason}` : ""}
            </div>
            {changed ? (
              <div className="diff" title={JSON.stringify(event.payload_diff, null, 2)}>
                {changed}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
