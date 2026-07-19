/**
 * Deferred (UI-SPEC §5.3) — snoozed items.
 *
 * Both of §5.3's promises are now real. `defer_until` carries the resurface
 * moment, computed at defer time and pushed past quiet hours, so the row shows
 * when the item comes back rather than when it was snoozed. "Drop" sends the
 * item's own discard response, because `deferred → rejected` is a legal
 * transition now.
 *
 * `responsesFor` falls back to the universal `dismiss` when the capability
 * declares no discard of its own, so there is always something to send and Drop
 * never renders dead. It still filters on `answerable`: an unloaded manifest can
 * leave a *guessed* discard in the list that the daemon would refuse.
 */
import { useState } from "react";
import { api, type ApiError } from "../api/client";
import type { ActionItem } from "../api/types";
import { Button } from "../components/primitives";
import { EmptyState, ErrorBanner, SkeletonRows } from "../components/states";
import type { Catalogue } from "../lib/manifest";
import { itemTitle, responsesFor } from "../lib/manifest";
import { relativeTime, resurfaceLabel } from "../lib/format";
import { navigate } from "../lib/router";

export function DeferredView({
  items,
  loading,
  error,
  reload,
  catalogue,
  onToast,
}: {
  items: ActionItem[] | undefined;
  loading: boolean;
  error: ApiError | undefined;
  reload: () => void;
  catalogue: Catalogue;
  onToast: (message: string, variant: "ok" | "err") => void;
}) {
  const [dropping, setDropping] = useState<string | undefined>(undefined);

  // Soonest resurface first (§5.3). An item with no window sorts last: it
  // predates the defer_until column and nothing will wake it on its own.
  const sorted = [...(items ?? [])].sort((a, b) => {
    const at = a.defer_until ? Date.parse(a.defer_until) : Infinity;
    const bt = b.defer_until ? Date.parse(b.defer_until) : Infinity;
    return at - bt;
  });

  async function drop(item: ActionItem, responseId: string) {
    setDropping(item.id);
    try {
      await api.respond(item.id, { response_id: responseId });
      onToast("Dropped. Removed from the queue.", "ok");
      reload();
    } catch (err) {
      onToast((err as ApiError).message ?? "Could not drop that item.", "err");
    } finally {
      setDropping(undefined);
    }
  }

  return (
    <>
      <h1 className="h-greet">Deferred</h1>
      <p className="h-sub">Snoozed. These resurface in your inbox at the time shown.</p>

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}

      {loading && !items ? (
        <SkeletonRows count={3} />
      ) : sorted.length === 0 ? (
        <EmptyState>Nothing deferred. Snoozed items will show up here.</EmptyState>
      ) : (
        sorted.map((item) => {
          const resolved = catalogue.resolveItem(item);
          const discard = responsesFor(item, resolved).find(
            (r) => r.answerable && r.outcome === "discard",
          );
          const busy = dropping === item.id;

          return (
            <div className="lrow" key={item.id}>
              <div className="body">
                <b>{itemTitle(item, resolved)}</b>
                <div className="m">
                  You deferred this {relativeTime(item.updated_at)} · from{" "}
                  {item.context.source.kind} · {item.capability_id}
                </div>
              </div>
              {item.defer_until ? (
                <div className="when">↩ {resurfaceLabel(item.defer_until)}</div>
              ) : (
                <div
                  className="when"
                  style={{ color: "var(--muted)" }}
                  title="Deferred before resurface times existed, so nothing will wake it on its own. Act on it here."
                >
                  ↩ no schedule
                </div>
              )}
              <div style={{ display: "flex", gap: 7 }}>
                <Button small onClick={() => navigate(`/inbox/${item.id}`)} disabled={busy}>
                  Act now
                </Button>
                <Button
                  small
                  disabled={!discard || busy}
                  onClick={discard ? () => void drop(item, discard.id) : undefined}
                  title={
                    discard
                      ? undefined
                      : "Nothing here can be sent for this item. This should not happen: dismiss is universal."
                  }
                >
                  {busy ? "Dropping…" : "Drop"}
                </Button>
              </div>
            </div>
          );
        })
      )}
    </>
  );
}
