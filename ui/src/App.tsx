/**
 * App shell and the data root (Command Centre D2).
 *
 * The datasets shared across views (capabilities, inbox items, tasks, deferred
 * items, completed items) are fetched here so the sidebar counts, the Now tiles,
 * the Inbox list, and the Tasks view never disagree.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "./api/client";
import { CommandBar } from "./components/CommandBar";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/states";
import { Catalogue } from "./lib/manifest";
import { useRoute } from "./lib/router";
import { COMPLETED_STATUSES, INBOX_STATUSES } from "./lib/transitions";
import { useAsync } from "./lib/useAsync";
import { ActivityView } from "./views/Activity";
import { AskView } from "./views/Ask";
import { CompletedView } from "./views/Completed";
import { DashboardView } from "./views/Dashboard";
import { DeferredView } from "./views/Deferred";
import { InboxView } from "./views/Inbox";
import { SettingsView } from "./views/Settings";
import { TasksView } from "./views/Tasks";

/** The question lives in the route hash; decode defensively so a bad %-escape
 * shows the raw text rather than throwing the whole shell. */
function decodeHash(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

interface ToastState {
  message: string;
  variant: "ok" | "err";
  key: number;
}

export function App() {
  const route = useRoute();
  const [toast, setToast] = useState<ToastState | undefined>(undefined);

  const capabilities = useAsync(() => api.capabilities(), []);
  const inbox = useAsync(() => api.listActions({ status: INBOX_STATUSES, limit: 200 }), []);
  const tasks = useAsync(() => api.listTasks({ limit: 100 }), []);
  const deferred = useAsync(() => api.listActions({ status: "deferred", limit: 200 }), []);
  const completed = useAsync(() => api.listActions({ status: COMPLETED_STATUSES, limit: 200 }), []);

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

  const reloadAll = () => {
    inbox.reload();
    tasks.reload();
    deferred.reload();
    completed.reload();
  };

  const activeTasksCount = useMemo(
    () =>
      (tasks.data ?? []).filter(
        (t) => t.status === "running" || t.status === "needs_input" || t.status === "queued",
      ).length,
    [tasks.data],
  );

  const statusLine = capabilities.error
    ? "daemon unreachable"
    : `${capabilityList.length} ${capabilityList.length === 1 ? "capability" : "capabilities"} loaded · ${problems.length} problem${problems.length === 1 ? "" : "s"} · local-first`;

  const askQuery = route.view === "ask" ? decodeHash(route.hash) : "";

  return (
    <div className="app">
      <Sidebar
        active={route.view}
        inboxCount={inbox.data?.length}
        tasksCount={activeTasksCount}
        deferredCount={deferred.data?.length}
        statusLine={statusLine}
        askQuery={askQuery}
        onTaskCreated={reloadAll}
        onToast={showToast}
      />

      <main className="main">
        {route.view === "dashboard" ? (
          <DashboardView
            inbox={inbox.data}
            tasks={tasks.data}
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
            onToast={showToast}
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

        {route.view === "tasks" ? (
          <TasksView
            tasks={tasks.data}
            loading={tasks.loading}
            error={tasks.error}
            reload={reloadAll}
            selectedId={route.itemId}
            onToast={showToast}
          />
        ) : null}

        {route.view === "activity" ? (
          <ActivityView
            completedItems={completed.data}
            completedLoading={completed.loading}
            completedError={completed.error}
            reloadCompleted={completed.reload}
            catalogue={catalogue}
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

        {route.view === "ask" ? <AskView question={askQuery} /> : null}
      </main>

      {toast ? <Toast key={toast.key} message={toast.message} variant={toast.variant} /> : null}
      <CommandBar onTaskCreated={reloadAll} onToast={showToast} />
    </div>
  );
}
