/**
 * Deferred (UI-SPEC §5.3) — snoozed items.
 *
 * Two things §5.3 describes that v0 cannot honestly show, both surfaced in the
 * UI rather than faked:
 *
 *  - There is no resurface time. Nothing in the schema stores a defer window and
 *    nothing sweeps `deferred` back to `pending`, so the row shows when it was
 *    deferred and says the return trip is manual.
 *  - "Drop" has no API path. `deferred → rejected` is not a legal transition
 *    (`src/store/action-items.ts`), so the button is disabled with the reason
 *    rather than left to fail with a 409.
 */
import type { ActionItem } from "../api/types";
import type { ApiError } from "../api/client";
import { Button } from "../components/primitives";
import { EmptyState, ErrorBanner, SkeletonRows } from "../components/states";
import type { Catalogue } from "../lib/manifest";
import { itemTitle } from "../lib/manifest";
import { relativeTime } from "../lib/format";
import { navigate } from "../lib/router";

export function DeferredView({
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
  const sorted = [...(items ?? [])].sort(
    (a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at),
  );

  return (
    <>
      <h1 className="h-greet">Deferred</h1>
      <p className="h-sub">
        Snoozed. Open one to act on it now, or leave it here.
      </p>

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}

      <div className="notice">
        <b>No resurface schedule yet.</b> The daemon has no job that moves a deferred item back to
        pending, so these stay here until you open one. Deferring is a way to clear the inbox, not a
        reminder.
      </div>

      {loading && !items ? (
        <SkeletonRows count={3} />
      ) : sorted.length === 0 ? (
        <EmptyState>Nothing deferred. Snoozed items will show up here.</EmptyState>
      ) : (
        sorted.map((item) => (
          <div className="lrow" key={item.id}>
            <div className="body">
              <b>{itemTitle(item, catalogue.resolveItem(item))}</b>
              <div className="m">
                You deferred this {relativeTime(item.updated_at)} · from{" "}
                {item.context.source.kind} · {item.capability_id}
              </div>
            </div>
            <div style={{ display: "flex", gap: 7 }}>
              <Button small onClick={() => navigate(`/inbox/${item.id}`)}>
                Act now
              </Button>
              <Button
                small
                disabled
                title="The API has no deferred to rejected transition, so a drop would be refused. Open the item and respond from there."
              >
                Drop
              </Button>
            </div>
          </div>
        ))
      )}
    </>
  );
}
