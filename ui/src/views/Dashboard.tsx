/**
 * Now / Dashboard (UI-SPEC §5.1, Command Centre D2) - "what's the state of my world"
 * in one screenful, including active delegated tasks and the Phase 1 Meetings Loop.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api, type ApiError } from "../api/client";
import type { ActionItem, CapabilityManifest, LoadProblem, Task } from "../api/types";
import { EmptyState, ErrorBanner, Skeleton, SkeletonRows } from "../components/states";
import { Badge, Button, StatusDot } from "../components/primitives";
import type { Catalogue } from "../lib/manifest";
import { itemTitle } from "../lib/manifest";
import { byPriorityThenNewest, clockTime, greeting, relativeTime } from "../lib/format";
import { navigate } from "../lib/router";
import { useAsync } from "../lib/useAsync";
import { usePoll } from "../lib/usePoll";

export function DashboardView({
  inbox,
  tasks,
  deferred,
  autoHandled,
  capabilities,
  problems,
  catalogue,
  loading,
  error,
  reload,
  onToast,
}: {
  inbox: ActionItem[] | undefined;
  tasks?: Task[] | undefined;
  deferred: ActionItem[] | undefined;
  autoHandled: ActionItem[] | undefined;
  capabilities: CapabilityManifest[];
  problems: LoadProblem[];
  catalogue: Catalogue;
  loading: boolean;
  error: ApiError | undefined;
  reload: () => void;
  onToast: (message: string, variant?: "ok" | "err") => void;
}) {
  const items = [...(inbox ?? [])].sort(byPriorityThenNewest);
  const urgent = items.filter((item) => item.priority === "urgent" || item.priority === "high");
  const today = (autoHandled ?? []).filter(isToday);
  const pendingByCapability = catalogue.pendingByCapability(items);

  const activeTasks = (tasks ?? []).filter(
    (t) => t.status === "running" || t.status === "needs_input" || t.status === "queued",
  );
  const needsInputTasks = activeTasks.filter((t) => t.status === "needs_input");

  const enabled = capabilities.filter((capability) => capability.enabled);

  // Today, running work and source freshness come from one snapshot (D2).
  const now = useAsync(() => api.now(), []);
  usePoll(now.reload, 30_000);
  const meetings = now.data?.meetings ?? [];
  const running = now.data?.running ?? [];
  const staleSources = (now.data?.sync_cursors ?? []).filter((c) => c.last_error);

  const [showMeetingForm, setShowMeetingForm] = useState(false);
  const [meetingEventId, setMeetingEventId] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingAttendees, setMeetingAttendees] = useState("");
  const [meetingNotes, setMeetingNotes] = useState("");
  const [submittingMeeting, setSubmittingMeeting] = useState(false);

  // The after-meeting nudge links here as /now?meeting=<event id>.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("meeting");
    if (id) {
      setMeetingEventId(id);
      setShowMeetingForm(true);
    }
  }, []);

  const submitMeeting = async (event: FormEvent) => {
    event.preventDefault();
    if (!meetingNotes.trim() || submittingMeeting) return;
    setSubmittingMeeting(true);
    try {
      const attendees = meetingAttendees
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api.submitMeetingNotes({
        ...(meetingEventId ? { event_id: meetingEventId } : {}),
        ...(meetingTitle.trim() ? { title: meetingTitle.trim() } : {}),
        ...(attendees.length ? { attendees } : {}),
        notes: meetingNotes.trim(),
      });
      if (res.status !== "ok") {
        onToast(`Notes not processed: ${res.error ?? res.status}`, "err");
        return;
      }
      setMeetingEventId("");
      setMeetingTitle("");
      setMeetingAttendees("");
      setMeetingNotes("");
      setShowMeetingForm(false);
      reload();
      onToast(
        res.accepted.length
          ? `${res.accepted.length} item(s) to review in the Inbox`
          : "Notes saved; nothing to file was found in them",
      );
    } catch (err) {
      onToast(`Meeting note failed: ${(err as Error).message}`, "err");
    } finally {
      setSubmittingMeeting(false);
    }
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 className="h-greet">{greeting()}, Sandip</h1>
          <p className="h-sub">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
            {" · "}
            {items.length} {items.length === 1 ? "thing needs" : "things need"} you,{" "}
            {activeTasks.length} active {activeTasks.length === 1 ? "task" : "tasks"},{" "}
            {today.length} handled automatically today.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button small onClick={() => setShowMeetingForm((v) => !v)}>
            {showMeetingForm ? "Close Meeting Note" : "+ Capture Meeting Notes"}
          </Button>
          <Button small variant="primary" onClick={() => navigate("/tasks")}>
            Delegate Task
          </Button>
        </div>
      </div>

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}
      {problems.length > 0 ? (
        <div className="banner" role="alert">
          <div className="msg">
            <div>
              {problems.length} {problems.length === 1 ? "capability" : "capabilities"} failed to
              load.
            </div>
            <div className="detail-text">
              {problems
                .map((problem) => `${problem.capabilityId ?? problem.dir}: ${problem.message}`)
                .join(" · ")}
            </div>
          </div>
        </div>
      ) : null}

      {showMeetingForm ? (
        <form className="card" onSubmit={(e) => void submitMeeting(e)}>
          <h2>Meeting notes</h2>
          <select
            className="fi"
            style={{ marginBottom: 10, width: "100%" }}
            value={meetingEventId}
            onChange={(e) => setMeetingEventId(e.target.value)}
          >
            <option value="">Not from the calendar</option>
            {meetingEventId && !meetings.some((m) => m.id === meetingEventId) ? (
              <option value={meetingEventId}>The meeting from your nudge</option>
            ) : null}
            {meetings.map((m) => (
              <option key={m.id} value={m.id}>
                {clockTime(m.starts_at)} · {m.title}
              </option>
            ))}
          </select>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <input
              className="fi"
              placeholder="Meeting topic (e.g., Q3 Architecture Sync)"
              value={meetingTitle}
              onChange={(e) => setMeetingTitle(e.target.value)}
            />
            <input
              className="fi"
              placeholder="Attendees (comma-separated, e.g., Sandip, Priya, Rohan)"
              value={meetingAttendees}
              onChange={(e) => setMeetingAttendees(e.target.value)}
            />
          </div>
          <textarea
            className="draft short"
            rows={4}
            placeholder="Paste raw meeting notes or transcript lines (lines starting with Decision:, Action:, Task:, Insight: are automatically extracted for review)..."
            value={meetingNotes}
            onChange={(e) => setMeetingNotes(e.target.value)}
          />
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <Button
              type="submit"
              variant="good"
              small
              pending={submittingMeeting}
              disabled={submittingMeeting || !meetingNotes.trim()}
            >
              Write Vault Note &amp; Extract Items
            </Button>
          </div>
        </form>
      ) : null}

      {meetings.length > 0 || running.length > 0 || staleSources.length > 0 ? (
        <div className="card">
          <h2>Today</h2>
          {meetings.map((m) => (
            <div key={m.id} className="lrow">
              <StatusDot state="idle" label="meeting" />
              <span style={{ flex: 1 }}>
                <b>{clockTime(m.starts_at)}</b> {m.title}
                {m.attendees.length ? <span className="tm"> · {m.attendees.join(", ")}</span> : null}
              </span>
            </div>
          ))}
          {running.map((r) => (
            <div key={r.id} className="lrow">
              <StatusDot state="idle" label="running" />
              <span style={{ flex: 1 }}>
                Running: {r.capability_id ?? "delegated task"}{" "}
                <span className="tm">since {relativeTime(r.started_at)}</span>
              </span>
            </div>
          ))}
          {staleSources.map((c) => (
            <div key={c.source} className="lrow">
              <StatusDot state="err" label="source error" />
              <span style={{ flex: 1 }}>
                {c.source} last synced {c.last_success_at ? relativeTime(c.last_success_at) : "never"}:{" "}
                <span className="tm">{c.last_error}</span>
              </span>
            </div>
          ))}
          {now.data ? (
            <div className="mode-note">
              Worker spend this month: ${now.data.worker.month_spend_usd.toFixed(2)} of $
              {now.data.worker.monthly_budget_usd}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={error ? "tiles dimmed" : "tiles"}>
        {loading && !inbox ? (
          <Skeleton variant="tile" count={4} />
        ) : (
          <>
            <Tile
              label="Needs you"
              value={items.length}
              sub={urgent.length > 0 ? `${urgent.length} urgent or high` : "nothing urgent"}
              alert={urgent.length > 0}
            />
            <Tile
              label="Active tasks"
              value={activeTasks.length}
              sub={
                needsInputTasks.length > 0
                  ? `${needsInputTasks.length} waiting for your input`
                  : "workers running or idle"
              }
              alert={needsInputTasks.length > 0}
            />
            <Tile
              label="Auto-handled today"
              value={today.length}
              sub="no action needed"
            />
            <Tile
              label="Capabilities"
              value={`${enabled.length} / ${capabilities.length}`}
              sub={problems.length > 0 ? `${problems.length} failed to load` : "all loaded"}
            />
          </>
        )}
      </div>

      {activeTasks.length > 0 ? (
        <div className="card">
          <h2>
            Active &amp; Waiting Tasks
            <button className="link" type="button" onClick={() => navigate("/tasks")}>
              Open tasks
            </button>
          </h2>
          {activeTasks.slice(0, 5).map((task) => (
            <button
              type="button"
              className="qrow"
              key={task.id}
              onClick={() => navigate(`/tasks/${encodeURIComponent(task.id)}`)}
            >
              <span
                className={task.status === "needs_input" ? "prio u" : "prio n"}
                aria-hidden="true"
              />
              <span className="t">
                {task.goal}
                <small>
                  lane: {task.lane} · status: {task.status} · updated {relativeTime(task.updated_at)}
                </small>
              </span>
              <Badge
                spec={{
                  label: task.status.replace(/_/g, " "),
                  variant: task.status === "needs_input" ? "assist" : "guided",
                }}
              />
            </button>
          ))}
        </div>
      ) : null}

      <div className="card">
        <h2>
          Plugged-in capabilities
          <button className="link" type="button" onClick={() => navigate("/settings")}>
            Settings
          </button>
        </h2>
        {capabilities.length === 0 ? (
          <EmptyState left>
            No capabilities yet. Drop one into <code>capabilities/</code> and reload the daemon.
          </EmptyState>
        ) : (
          <div className="agents">
            {capabilities.map((capability) => (
              <AgentCard
                key={capability.id}
                capability={capability}
                pending={pendingByCapability.get(capability.id) ?? 0}
                onRan={reload}
                onToast={onToast}
              />
            ))}
          </div>
        )}
      </div>

      <div className="grid2">
        <div className="card">
          <h2>
            Needs you now
            <button className="link" type="button" onClick={() => navigate("/inbox")}>
              Open inbox
            </button>
          </h2>
          {loading && !inbox ? (
            <SkeletonRows count={3} />
          ) : items.length === 0 ? (
            <EmptyState>Nothing needs you right now.</EmptyState>
          ) : (
            items.slice(0, 6).map((item) => (
              <button
                type="button"
                className="qrow"
                key={item.id}
                onClick={() => navigate(`/inbox/${item.id}`)}
              >
                <span
                  className={
                    item.priority === "urgent" || item.priority === "high" ? "prio u" : "prio n"
                  }
                  aria-hidden="true"
                />
                <span className="t">
                  {itemTitle(item, catalogue.resolveItem(item))}
                  <small>{item.context.why_flagged || item.context.decision_needed}</small>
                </span>
                <span className="tag">{item.context.source.kind || item.capability_id}</span>
              </button>
            ))
          )}
        </div>

        <div className="card">
          <h2>Handled automatically today</h2>
          {loading && !autoHandled ? (
            <SkeletonRows count={3} />
          ) : today.length === 0 ? (
            <EmptyState left>Nothing was auto-handled today.</EmptyState>
          ) : (
            today.slice(0, 8).map((item) => (
              <div className="frow" key={item.id}>
                <span className="tm">{clockTime(item.updated_at)}</span>
                <span style={{ flex: 1 }}>
                  {itemTitle(item, catalogue.resolveItem(item))}
                  <br />
                  <span className="who">{item.capability_id}</span>
                </span>
              </div>
            ))
          )}
          <div className="trust-note">
            Auto-handled means high-confidence, low-blast-radius and reversible. Everything else is
            escalated to your inbox.
          </div>
        </div>
      </div>

      {deferred && deferred.length > 0 ? (
        <div className="card">
          <h2>
            Deferred
            <button className="link" type="button" onClick={() => navigate("/deferred")}>
              See all
            </button>
          </h2>
          {deferred.slice(0, 3).map((item) => (
            <div className="frow" key={item.id}>
              <span className="tm">{relativeTime(item.updated_at)}</span>
              <span style={{ flex: 1 }}>{itemTitle(item, catalogue.resolveItem(item))}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function Tile({
  label,
  value,
  sub,
  alert,
}: {
  label: string;
  value: number | string;
  sub: string;
  alert?: boolean;
}) {
  return (
    <div className={alert ? "tile alert" : "tile"}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

function isToday(item: ActionItem): boolean {
  const at = new Date(Date.parse(item.updated_at));
  const now = new Date();
  return (
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  );
}

function AgentCard({
  capability,
  pending,
  onRan,
  onToast,
}: {
  capability: CapabilityManifest;
  pending: number;
  onRan: () => void;
  onToast: (message: string, variant?: "ok" | "err") => void;
}) {
  const [running, setRunning] = useState(false);

  const degraded = capability.types?.some((type) => type.degraded_reason);
  const failed = capability.last_run_status && capability.last_run_status !== "ok";
  const state = !capability.enabled ? "idle" : degraded || failed ? "err" : "ok";

  const run = async () => {
    setRunning(true);
    try {
      const report = await api.runCapability(capability.id);
      const waiting = report.accepted.filter((a) => a.status === "pending").length;
      const auto = report.accepted.filter((a) => a.status === "executed").length;

      if (report.status !== "ok") {
        onToast(`${capability.name}: ${report.error ?? report.status}`, "err");
      } else if (!report.accepted.length) {
        onToast(`${capability.name} ran, nothing to surface`);
      } else {
        const parts = [
          waiting ? `${waiting} for you` : "",
          auto ? `${auto} handled automatically` : "",
        ].filter(Boolean);
        onToast(`${capability.name}: ${parts.join(", ")}`);
      }
      onRan();
    } catch (err) {
      onToast(`Could not run ${capability.name}: ${(err as Error).message}`, "err");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={state === "err" ? "agent err" : "agent"} title={capability.description}>
      <div className="top">
        <StatusDot
          state={state}
          label={!capability.enabled ? "disabled" : degraded ? "degraded" : "active"}
        />
        <b>{capability.name}</b>
        <button className="link" type="button" onClick={run} disabled={running}>
          {running ? "running..." : "Run now"}
        </button>
      </div>
      <div className="meta">
        {capability.trigger.mode}
        {capability.trigger.command ? ` (${capability.trigger.command})` : ""} ·{" "}
        {capability.last_run_at
          ? `last run ${relativeTime(capability.last_run_at)}${
              failed ? ` (${capability.last_run_status})` : ""
            }`
          : "never run"}
        <br />
        {pending > 0 ? <span className="pend">{pending} waiting for you</span> : "nothing waiting"}
        {degraded ? (
          <>
            <br />
            degraded to guided:{" "}
            {capability.types.find((type) => type.degraded_reason)?.degraded_reason}
          </>
        ) : null}
      </div>
    </div>
  );
}
