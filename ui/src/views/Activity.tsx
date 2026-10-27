/**
 * Activity view (Command Centre D2).
 *
 * Unified observability surface across:
 *  - Active & recent `runs` (with real Stop button `POST /api/runs/:id/cancel`)
 *  - Append-only `activity_events`
 *  - Event Bus `seen_events`
 *  - Completed action items archive
 */
import { useState } from "react";
import { api, type ApiError } from "../api/client";
import type { ActionItem } from "../api/types";
import { Badge, Button, StatusDot } from "../components/primitives";
import { EmptyState, ErrorBanner, SkeletonRows } from "../components/states";
import { clockTime, relativeTime } from "../lib/format";
import type { Catalogue } from "../lib/manifest";
import { navigate } from "../lib/router";
import { useAsync } from "../lib/useAsync";
import { CompletedView } from "./Completed";

export function ActivityView({
  completedItems,
  completedLoading,
  completedError,
  reloadCompleted,
  catalogue,
  onToast,
}: {
  completedItems: ActionItem[] | undefined;
  completedLoading: boolean;
  completedError: ApiError | undefined;
  reloadCompleted: () => void;
  catalogue: Catalogue;
  onToast: (message: string, variant?: "ok" | "err") => void;
}) {
  const [tab, setTab] = useState<"stream" | "completed">("stream");
  const feed = useAsync(() => api.activity(100), []);
  const [stoppingRunId, setStoppingRunId] = useState<string | undefined>(undefined);

  const stopRun = async (runId: string) => {
    setStoppingRunId(runId);
    try {
      await api.cancelRun(runId, "Stopped from Activity view");
      onToast(`Stopped run ${runId} and fenced lease`);
      feed.reload();
    } catch (err) {
      onToast(`Could not stop run: ${(err as Error).message}`, "err");
    } finally {
      setStoppingRunId(undefined);
    }
  };

  if (tab === "completed") {
    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div className="lanes" style={{ padding: 0 }}>
            <button type="button" className="lane" onClick={() => setTab("stream")}>
              Live Activity Stream
            </button>
            <button type="button" className="lane active" onClick={() => setTab("completed")}>
              Completed Decisions ({completedItems?.length ?? 0})
            </button>
          </div>
        </div>
        <CompletedView
          items={completedItems}
          loading={completedLoading}
          error={completedError}
          reload={reloadCompleted}
          catalogue={catalogue}
        />
      </>
    );
  }

  const runs = feed.data?.runs ?? [];
  const activityEvents = feed.data?.events ?? [];
  const seenEvents = feed.data?.seen_events ?? [];

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div>
          <h1 className="h-greet">Activity</h1>
          <p className="h-sub">
            Live runs, append-only worker/run events, Event Bus intake, and completed decisions.
          </p>
        </div>
        <div className="lanes" style={{ padding: 0 }}>
          <button type="button" className="lane active" onClick={() => setTab("stream")}>
            Live Activity Stream
          </button>
          <button type="button" className="lane" onClick={() => setTab("completed")}>
            Completed Decisions ({completedItems?.length ?? 0})
          </button>
        </div>
      </div>

      {feed.error ? <ErrorBanner error={feed.error} onRetry={feed.reload} /> : null}

      <div className="card">
        <h2>
          Capability &amp; Worker Runs
          <button className="link" type="button" onClick={feed.reload}>
            Refresh
          </button>
        </h2>
        {feed.loading && !feed.data ? (
          <SkeletonRows count={3} />
        ) : runs.length === 0 ? (
          <EmptyState left>No runs recorded yet.</EmptyState>
        ) : (
          runs.slice(0, 15).map((run) => (
            <div key={run.id} className="lrow">
              <StatusDot
                state={
                  run.status === "succeeded"
                    ? "ok"
                    : run.status === "running"
                      ? "idle"
                      : "err"
                }
                label={run.status}
              />
              <div className="body">
                <b>{run.capability_id ?? "worker"}</b>{" "}
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  (<code>{run.id}</code> · {run.runner})
                </span>
                <div className="m">
                  Started {relativeTime(run.started_at)} · lease gen <code>{run.fencing_generation}</code>
                  {run.error ? ` · ${run.error}` : ""}
                </div>
              </div>
              <Badge
                spec={{
                  label: run.status,
                  variant:
                    run.status === "succeeded"
                      ? "auto"
                      : run.status === "running"
                        ? "guided"
                        : run.status === "cancelled" || run.status === "skipped"
                          ? "neutral"
                          : "urgent",
                }}
              />
              {run.status === "running" ? (
                <Button
                  small
                  pending={stoppingRunId === run.id}
                  disabled={stoppingRunId === run.id}
                  onClick={() => void stopRun(run.id)}
                >
                  Stop Run
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Append-Only Activity Events ({activityEvents.length})</h2>
          {feed.loading && !feed.data ? (
            <SkeletonRows count={4} />
          ) : activityEvents.length === 0 ? (
            <EmptyState left>No activity events recorded yet.</EmptyState>
          ) : (
            activityEvents.slice(0, 25).map((ev) => (
              <div key={ev.id} className="frow">
                <span className="tm">{clockTime(ev.created_at)}</span>
                <span style={{ flex: 1 }}>
                  <code>{ev.type}</code>
                  {ev.capability_id ? (
                    <>
                      {" · "}
                      <span className="who">{ev.capability_id}</span>
                    </>
                  ) : null}
                  {ev.task_id ? (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="link"
                        style={{ fontSize: 12, color: "var(--core)", background: "none", border: 0, padding: 0, cursor: "pointer" }}
                        onClick={() => navigate(`/tasks/${encodeURIComponent(ev.task_id!)}`)}
                      >
                        {ev.task_id}
                      </button>
                    </>
                  ) : null}
                  <br />
                  <small style={{ color: "var(--muted)", fontSize: 11.5 }}>
                    {JSON.stringify(ev.payload)}
                  </small>
                </span>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <h2>Event Bus Intake ({seenEvents.length})</h2>
          {feed.loading && !feed.data ? (
            <SkeletonRows count={4} />
          ) : seenEvents.length === 0 ? (
            <EmptyState left>No inbound events recorded yet.</EmptyState>
          ) : (
            seenEvents.slice(0, 20).map((ev) => (
              <div key={ev.id} className="frow">
                <span className="tm">{clockTime(ev.seen_at)}</span>
                <span style={{ flex: 1 }}>
                  <b>{ev.event_type}</b>
                  <br />
                  <code style={{ color: "var(--muted)" }}>{ev.id}</code>
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
