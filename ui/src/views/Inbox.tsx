/**
 * Inbox (UI-SPEC §5.2) — the two-pane review surface, and the only view that
 * matters when there is a batch to get through.
 *
 * List order is the server's (urgent first, then newest), preserved across the
 * fan-out over the four inbox statuses. Selection follows the route so a
 * Dashboard row or a Telegram deep link can land on a specific item, but an
 * implicit first-item selection does not push history: arriving at /inbox and
 * immediately owning a back-button entry would be wrong.
 */
import { useMemo, useState } from "react";
import type { ActionItem } from "../api/types";
import type { ApiError } from "../api/client";
import { ItemDetail } from "../components/ItemDetail";
import { ItemRow } from "../components/ItemRow";
import { EmptyState, ErrorBanner, SkeletonDetail, SkeletonRows } from "../components/states";
import type { Catalogue } from "../lib/manifest";
import { byPriorityThenNewest, titleCase } from "../lib/format";
import { navigate } from "../lib/router";

export function InboxView({
  items,
  loading,
  error,
  reload,
  catalogue,
  selectedId,
  onToast,
}: {
  items: ActionItem[] | undefined;
  loading: boolean;
  error: ApiError | undefined;
  reload: () => void;
  catalogue: Catalogue;
  selectedId: string | undefined;
  onToast: (message: string) => void;
}) {
  const [lane, setLane] = useState("all");

  const sorted = useMemo(() => [...(items ?? [])].sort(byPriorityThenNewest), [items]);

  // §5.2 wants lane chips. No capability declares a lane in v0, so the chips are
  // built from the source kinds actually present, which is the closest thing the
  // OS contract carries and stays correct as capabilities are added.
  const lanes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of sorted) {
      const kind = item.context.source.kind || item.capability_id;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [sorted]);

  const visible = useMemo(
    () =>
      lane === "all"
        ? sorted
        : sorted.filter((item) => (item.context.source.kind || item.capability_id) === lane),
    [sorted, lane],
  );

  // A routed id that is not in the list still opens: Deferred's "Act now" and a
  // Completed row both deep-link here, and refusing to render them would make
  // the audit trail unreachable for exactly the items whose history matters most.
  const detailId = selectedId ?? visible[0]?.id;

  const advance = (settled: ActionItem) => {
    const index = visible.findIndex((item) => item.id === settled.id);
    const next = visible[index + 1] ?? visible[index - 1];
    navigate(next ? `/inbox/${next.id}` : "/inbox", { replace: true });
    reload();
  };

  if (error && !items) {
    return (
      <>
        <Header count={0} />
        <ErrorBanner error={error} onRetry={reload} />
      </>
    );
  }

  return (
    <>
      <Header count={sorted.length} />

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}

      <div className={error ? "inbox dimmed" : "inbox"}>
        <div className="ilist">
          {lanes.length > 1 ? (
            <div className="lanes">
              <button
                type="button"
                className={lane === "all" ? "lane active" : "lane"}
                onClick={() => setLane("all")}
              >
                All · {sorted.length}
              </button>
              {lanes.map(([kind, count]) => (
                <button
                  key={kind}
                  type="button"
                  className={lane === kind ? "lane active" : "lane"}
                  onClick={() => setLane(kind)}
                >
                  {titleCase(kind)} · {count}
                </button>
              ))}
            </div>
          ) : null}

          <div className="list-head">Waiting for you</div>

          {loading && !items ? (
            <div style={{ padding: "8px 14px" }}>
              <SkeletonRows count={4} />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState left>
              {sorted.length === 0
                ? "Nothing needs you. Samaritan will surface things here the moment they do."
                : `Nothing in ${titleCase(lane)}.`}
            </EmptyState>
          ) : (
            visible.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                resolved={catalogue.resolveItem(item)}
                active={item.id === detailId}
                onSelect={() => navigate(`/inbox/${item.id}`)}
              />
            ))
          )}
        </div>

        <div className="detail">
          {loading && !items ? (
            <SkeletonDetail />
          ) : detailId ? (
            <ItemDetail
              key={detailId}
              itemId={detailId}
              catalogue={catalogue}
              onSettled={(settled, outcome) => {
                onToast(outcome);
                advance(settled);
              }}
              onUpdated={() => reload()}
            />
          ) : (
            <EmptyState>
              Inbox zero.
              <br />
              Nothing needs your decision right now.
            </EmptyState>
          )}
        </div>
      </div>
    </>
  );
}

function Header({ count }: { count: number }) {
  return (
    <>
      <h1 className="h-greet">Inbox</h1>
      <p className="h-sub">
        {count === 0
          ? "Nothing needs your decision."
          : `${count} ${count === 1 ? "item needs" : "items need"} your decision. Each renders the surface its type needs.`}
      </p>
    </>
  );
}

