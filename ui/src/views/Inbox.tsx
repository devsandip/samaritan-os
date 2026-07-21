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
import { useEffect, useMemo, useState } from "react";
import type { ActionItem } from "../api/types";
import { api, type ApiError } from "../api/client";
import { ItemDetail } from "../components/ItemDetail";
import { ItemRow } from "../components/ItemRow";
import { Button } from "../components/primitives";
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

  // Batch-approve (§12 step 23) is an opt-in mode, so the everyday one-at-a-time
  // review flow is untouched until Sandip asks to select. Selection is confined
  // to a single type — "similar items" is the same (capability, type), which
  // share responses and a review surface — and the daemon's risk gate holds back
  // anything high-stakes even inside that set.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const keyOf = (item: ActionItem) => `${item.capability_id}::${item.type}`;

  // Drop selected ids that have left the visible list (settled after a batch, or
  // filtered out by a lane switch) so the count never lies.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => visible.some((i) => i.id === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visible]);

  const pendingCount = useMemo(
    () => visible.filter((i) => i.status === "pending").length,
    [visible],
  );

  const groupItem = useMemo(
    () => visible.find((i) => selected.has(i.id)),
    [visible, selected],
  );
  const groupKey = groupItem ? keyOf(groupItem) : undefined;

  // The type's committing response (its "approve"): the first execute/guided
  // response, preferring the plain one over an "edit and file" variant.
  const approveResponse = useMemo(() => {
    if (!groupItem) return undefined;
    const responses = catalogue.resolveItem(groupItem)?.spec.responses ?? [];
    const commit = responses.filter((r) => r.outcome === "execute" || r.outcome === "guided");
    return commit.find((r) => !/edit/i.test(r.id)) ?? commit[0];
  }, [groupItem, catalogue]);

  const leaveSelect = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const toggleSelected = (item: ActionItem) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  };

  const runBatch = async () => {
    if (!approveResponse || selected.size === 0) return;
    const ids = [...selected];
    setBusy(true);
    try {
      const result = await api.batch(ids, approveResponse.id);
      const parts: string[] = [];
      if (result.applied.length) parts.push(`Approved ${result.applied.length}`);
      if (result.skipped.length) parts.push(`${result.skipped.length} held for review`);
      if (result.errors.length) parts.push(`${result.errors.length} couldn’t be applied`);
      onToast(parts.join(" · ") || "Nothing to approve");
      setSelected(new Set());
      reload();
    } catch (err) {
      onToast(`Batch failed: ${(err as ApiError).message}`);
    } finally {
      setBusy(false);
    }
  };

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
                onClick={() => {
                  setLane("all");
                  setSelected(new Set());
                }}
              >
                All · {sorted.length}
              </button>
              {lanes.map(([kind, count]) => (
                <button
                  key={kind}
                  type="button"
                  className={lane === kind ? "lane active" : "lane"}
                  onClick={() => {
                    setLane(kind);
                    setSelected(new Set());
                  }}
                >
                  {titleCase(kind)} · {count}
                </button>
              ))}
            </div>
          ) : null}

          <div className="list-head list-head-row">
            <span>Waiting for you</span>
            {pendingCount >= 2 ? (
              <button type="button" className="select-toggle" onClick={() => (selecting ? leaveSelect() : setSelecting(true))}>
                {selecting ? "Cancel" : "Select"}
              </button>
            ) : null}
          </div>

          {selecting ? (
            <div className="batch-bar">
              <span className="batch-count">
                {selected.size === 0 ? "Pick similar items to approve together" : `${selected.size} selected`}
              </span>
              <Button
                variant="good"
                small
                pending={busy}
                disabled={busy || selected.size === 0 || !approveResponse}
                onClick={runBatch}
              >
                {approveResponse?.label ?? "Approve"}
                {selected.size ? ` · ${selected.size}` : ""}
              </Button>
            </div>
          ) : null}

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
            visible.map((item) => {
              const pickable = item.status === "pending";
              // Once a type is chosen, other types are locked out of this batch.
              const locked =
                pickable && groupKey !== undefined && keyOf(item) !== groupKey && !selected.has(item.id);
              return (
                <div key={item.id} className="irow">
                  {selecting ? (
                    <label className={`irow-check${locked ? " disabled" : ""}`}>
                      {pickable ? (
                        <input
                          type="checkbox"
                          checked={selected.has(item.id)}
                          disabled={locked}
                          onChange={() => toggleSelected(item)}
                          aria-label="Select for batch approve"
                          title={locked ? "A batch approves one type at a time" : "Select for batch approve"}
                        />
                      ) : null}
                    </label>
                  ) : null}
                  <ItemRow
                    item={item}
                    resolved={catalogue.resolveItem(item)}
                    active={item.id === detailId}
                    onSelect={() => navigate(`/inbox/${item.id}`)}
                  />
                </div>
              );
            })
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

