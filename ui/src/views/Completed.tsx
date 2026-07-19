/**
 * Completed (UI-SPEC §5.4) — the audit trail as a day-grouped list.
 *
 * Rows are clickable and open the item's full detail, which is where the
 * per-item transition history lives. That is the "why did we...?" path §5.4
 * asks for, grounded in the item's own provenance rather than a recall layer
 * that does not exist yet.
 *
 * `failed` is included here even though §5.4 does not name it: §9 requires a
 * failed execution to stay visible rather than vanish, and the Inbox keeps it
 * too, so it appears in both until it is retried.
 */
import { useMemo } from "react";
import type { ActionItem } from "../api/types";
import type { ApiError } from "../api/client";
import { EmptyState, ErrorBanner, SkeletonRows } from "../components/states";
import type { Catalogue } from "../lib/manifest";
import { itemTitle } from "../lib/manifest";
import { clockTime, dayLabel, decisionTag } from "../lib/format";
import { navigate } from "../lib/router";

export function CompletedView({
  items,
  loading,
  error,
  reload,
  catalogue,
}: {
  items: ActionItem[] | undefined;
  loading: boolean;
  error: ApiError | undefined;
  reload: () => void;
  catalogue: Catalogue;
}) {
  const groups = useMemo(() => {
    const sorted = [...(items ?? [])].sort(
      (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
    );
    const byDay = new Map<string, ActionItem[]>();
    for (const item of sorted) {
      const label = dayLabel(item.updated_at);
      const bucket = byDay.get(label);
      if (bucket) bucket.push(item);
      else byDay.set(label, [item]);
    }
    return [...byDay.entries()];
  }, [items]);

  return (
    <>
      <h1 className="h-greet">Completed</h1>
      <p className="h-sub">
        Every decision you made. Open a row to see its full transition history.
      </p>

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}

      {loading && !items ? (
        <SkeletonRows count={4} />
      ) : groups.length === 0 ? (
        <EmptyState>
          No completed items yet. Decisions you make in the Inbox will show up here.
        </EmptyState>
      ) : (
        groups.map(([label, rows]) => (
          <div key={label}>
            <div className="daygrp">{label}</div>
            {rows.map((item) => {
              const tag = decisionTag(item.status);
              return (
                <div
                  className="lrow"
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                  onClick={() => navigate(`/inbox/${item.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      navigate(`/inbox/${item.id}`);
                    }
                  }}
                >
                  <span className={`did ${tag.variant}`}>{tag.label}</span>
                  <div className="body">
                    <b>{itemTitle(item, catalogue.resolveItem(item))}</b>
                    <div className="m">
                      {item.capability_id} · {item.execution.mode} →{" "}
                      {item.context.execution_surface || item.execution.capability}
                    </div>
                  </div>
                  <span className="when">{clockTime(item.updated_at)}</span>
                </div>
              );
            })}
          </div>
        ))
      )}
    </>
  );
}
