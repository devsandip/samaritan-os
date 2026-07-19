/**
 * App shell and the data root.
 *
 * The three datasets every view shares (capabilities, inbox items, deferred
 * items) are fetched once here, so the sidebar count, the Dashboard tile and the
 * Inbox list can never disagree. Views that own a dataset nobody else needs
 * (Completed, routing) fetch it themselves.
 *
 * There is no polling. The daemon has no change stream, and a poll would fight
 * the "calm, non-intrusive" rule in UI-SPEC §1 by re-sorting the list under the
 * cursor mid-review. Every mutation already refetches what it invalidated.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "./api/client";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/states";
import { Catalogue } from "./lib/manifest";
import { useRoute } from "./lib/router";
import { COMPLETED_STATUSES, INBOX_STATUSES } from "./lib/transitions";
import { useAsync } from "./lib/useAsync";
import { CompletedView } from "./views/Completed";
import { DashboardView } from "./views/Dashboard";
import { DeferredView } from "./views/Deferred";
import { InboxView } from "./views/Inbox";
import { SettingsView } from "./views/Settings";

interface ToastState {
  message: string;
  variant: "ok" | "err";
  key: number;
}

export function App() {
  const route = useRoute();
  const [toast, setToast] = useState<ToastState | undefined>(undefined);

  const capabilities = useAsync(() => api.capabilities(), []);
  const inbox = useAsync(() => api.listActionsByStatuses(INBOX_STATUSES, { limit: 200 }), []);
  const deferred = useAsync(() => api.listActions({ status: "deferred", limit: 200 }), []);
  const completed = useAsync(
    () => api.listActionsByStatuses(COMPLETED_STATUSES, { limit: 200 }),
    [],
  );

  const catalogue = useMemo(
    () => new Catalogue(capabilities.data?.capabilities ?? []),
    [capabilities.data],
  );

  const showToast = (message: string, variant: "ok" | "err" = "ok") =>
    setToast({ message, variant, key: Date.now() });

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // §3.3: switching view or item resets the scroll position, so a long detail
  // pane never leaves the next item scrolled halfway down.
  useEffect(() => {
    document.querySelector(".main")?.scrollTo({ top: 0 });
    document.querySelector(".detail")?.scrollTo({ top: 0 });
  }, [route.view, route.itemId]);

  const capabilityList = capabilities.data?.capabilities ?? [];
  const problems = capabilities.data?.problems ?? [];

  // Anything that came back through the Inbox has to be re-read everywhere it
  // is counted, which is why acting on an item reloads all four lists.
  const reloadAll = () => {
    inbox.reload();
    deferred.reload();
    completed.reload();
  };

  const statusLine = capabilities.error
    ? "daemon unreachable"
    : `${capabilityList.length} ${capabilityList.length === 1 ? "capability" : "capabilities"} loaded · ${problems.length} problem${problems.length === 1 ? "" : "s"} · local-first`;

  return (
    <div className="app">
      <Sidebar
        active={route.view}
        inboxCount={inbox.data?.length}
        deferredCount={deferred.data?.length}
        statusLine={statusLine}
      />

      <main className="main">
        {route.view === "dashboard" ? (
          <DashboardView
            inbox={inbox.data}
            deferred={deferred.data}
            autoHandled={completed.data?.filter((item) => item.status === "executed")}
            capabilities={capabilityList}
            problems={problems}
            catalogue={catalogue}
            loading={inbox.loading || capabilities.loading}
            error={inbox.error ?? capabilities.error}
            reload={() => {
              capabilities.reload();
              reloadAll();
            }}
          />
        ) : null}

        {route.view === "inbox" ? (
          <InboxView
            items={inbox.data}
            loading={inbox.loading}
            error={inbox.error}
            reload={reloadAll}
            catalogue={catalogue}
            selectedId={route.itemId}
            onToast={showToast}
          />
        ) : null}

        {route.view === "deferred" ? (
          <DeferredView
            items={deferred.data}
            loading={deferred.loading}
            error={deferred.error}
            reload={deferred.reload}
            catalogue={catalogue}
            onToast={showToast}
          />
        ) : null}

        {route.view === "completed" ? (
          <CompletedView
            items={completed.data}
            loading={completed.loading}
            error={completed.error}
            reload={completed.reload}
            catalogue={catalogue}
          />
        ) : null}

        {route.view === "settings" ? (
          <SettingsView
            capabilities={capabilityList}
            problems={problems}
            loading={capabilities.loading}
            error={capabilities.error}
            reload={capabilities.reload}
            onToast={showToast}
          />
        ) : null}
      </main>

      {toast ? <Toast key={toast.key} message={toast.message} variant={toast.variant} /> : null}
    </div>
  );
}
