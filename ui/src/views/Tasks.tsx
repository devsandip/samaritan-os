/**
 * Tasks view (Command Centre D1/D2).
 *
 * Two-pane view for delegated background tasks:
 *  - Left pane: active, waiting (`needs_input`), completed (`succeeded`), and failed tasks,
 *    plus a delegate form to launch a new worker task.
 *  - Right pane: task status, real Stop button (`POST /api/tasks/:id/cancel`), inline
 *    clarification form (`POST /api/tasks/:id/answer`), scoped artifacts under
 *    `~/.samaritan/artifacts/<task-id>/` with content preview, and activity events.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api, type ApiError } from "../api/client";
import type { Artifact, Task, TaskLane, TaskStatus } from "../api/types";
import { Badge, Button, StatusDot } from "../components/primitives";
import { EmptyState, ErrorBanner, ErrorStrip, SkeletonDetail, SkeletonRows } from "../components/states";
import { clockTime, relativeTime } from "../lib/format";
import { navigate } from "../lib/router";
import { useAsync } from "../lib/useAsync";
import { usePoll } from "../lib/usePoll";

const STATUS_BADGE: Record<TaskStatus, { label: string; variant: "auto" | "assist" | "guided" | "urgent" | "neutral" }> = {
  queued: { label: "queued", variant: "neutral" },
  running: { label: "running", variant: "guided" },
  needs_input: { label: "needs input", variant: "assist" },
  awaiting_review: { label: "awaiting review", variant: "assist" },
  succeeded: { label: "succeeded", variant: "auto" },
  failed: { label: "failed", variant: "urgent" },
  cancelled: { label: "cancelled", variant: "neutral" },
  interrupted: { label: "interrupted", variant: "urgent" },
};

export function TasksView({
  tasks,
  loading,
  error,
  reload,
  selectedId,
  onToast,
}: {
  tasks: Task[] | undefined;
  loading: boolean;
  error: ApiError | undefined;
  reload: () => void;
  selectedId: string | undefined;
  onToast: (message: string, variant?: "ok" | "err") => void;
}) {
  const [goal, setGoal] = useState("");
  const [lane, setLane] = useState<TaskLane>("general");
  const [creating, setCreating] = useState(false);

  const list = tasks ?? [];
  const activeTaskId = selectedId ?? list[0]?.id;

  const submitGoal = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = goal.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const created = await api.createTask({ goal: trimmed, lane });
      setGoal("");
      reload();
      onToast(`Queued (${lane}); it runs in the background`);
      navigate(`/tasks/${encodeURIComponent(created.task.id)}`);
    } catch (err) {
      onToast(`Could not start task: ${(err as Error).message}`, "err");
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <h1 className="h-greet">Tasks</h1>
      <p className="h-sub">
        Work you hand off. Each task runs in the background on the Claude Agent SDK with no send or
        write access: it reads memory, writes files under{" "}
        <code>~/.samaritan/artifacts/&lt;task-id&gt;/</code>, and asks or proposes through the Inbox.
      </p>

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}

      <form className="card" onSubmit={(e) => void submitGoal(e)} style={{ marginBottom: 16 }}>
        <h2>Delegate a new task</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="fi"
            style={{ flex: 1, minWidth: 240 }}
            type="text"
            placeholder="Describe the goal (e.g., Audit Q3 vendor renewals and draft summary report)..."
            value={goal}
            disabled={creating}
            onChange={(e) => setGoal(e.target.value)}
          />
          <select
            className="rtable-select"
            value={lane}
            aria-label="Task lane"
            onChange={(e) => setLane(e.target.value as TaskLane)}
            style={{
              font: "inherit",
              fontSize: "13px",
              border: "1px solid var(--line)",
              borderRadius: "8px",
              padding: "9px 11px",
              background: "#fff",
            }}
          >
            <option value="general">general</option>
            <option value="coding">coding</option>
            <option value="research">research</option>
            <option value="operations">operations</option>
          </select>
          <Button type="submit" variant="primary" pending={creating} disabled={creating || !goal.trim()}>
            Delegate Task
          </Button>
        </div>
      </form>

      <div className={error ? "inbox dimmed" : "inbox"}>
        <div className="ilist">
          <div className="list-head">Delegated Tasks ({list.length})</div>
          {loading && !tasks ? (
            <div style={{ padding: "8px 14px" }}>
              <SkeletonRows count={4} />
            </div>
          ) : list.length === 0 ? (
            <EmptyState left>
              No delegated tasks yet. Submit a goal above or use the Delegate Task mode in the
              sidebar.
            </EmptyState>
          ) : (
            list.map((task) => {
              const badge = STATUS_BADGE[task.status];
              return (
                <button
                  key={task.id}
                  type="button"
                  className={task.id === activeTaskId ? "item active" : "item"}
                  onClick={() => navigate(`/tasks/${encodeURIComponent(task.id)}`)}
                >
                  <div className="item-top">
                    <span className={`src src-${task.lane === "coding" ? "coding" : "work"}`}>
                      {task.lane}
                    </span>
                    <span className="time">{relativeTime(task.updated_at)}</span>
                  </div>
                  <div className="item-title">{task.goal}</div>
                  {task.result_summary ? <div className="item-why">{task.result_summary}</div> : null}
                  <div className="item-badges">
                    <Badge spec={badge} />
                    <Badge spec={{ label: `r${task.revision}`, variant: "neutral" }} />
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="detail">
          {loading && !tasks ? (
            <SkeletonDetail />
          ) : activeTaskId ? (
            <TaskDetailPane
              key={activeTaskId}
              taskId={activeTaskId}
              onUpdated={reload}
              onToast={onToast}
            />
          ) : (
            <EmptyState>Select or delegate a task to inspect its runs and artifacts.</EmptyState>
          )}
        </div>
      </div>
    </>
  );
}

function TaskDetailPane({
  taskId,
  onUpdated,
  onToast,
}: {
  taskId: string;
  onUpdated: () => void;
  onToast: (message: string, variant?: "ok" | "err") => void;
}) {
  const detail = useAsync(() => api.getTask(taskId), [taskId]);
  const live = detail.data
    ? ["queued", "running", "needs_input", "awaiting_review"].includes(detail.data.task.status)
    : true;
  // A task moves on its own; follow it while it is in play.
  usePoll(detail.reload, 3_000, live);
  const [retrying, setRetrying] = useState(false);
  const [answer, setAnswer] = useState("");
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | undefined>(undefined);
  const [artifactContent, setArtifactContent] = useState<string | undefined>(undefined);
  const [loadingArtifact, setLoadingArtifact] = useState(false);

  useEffect(() => {
    setSelectedArtifact(undefined);
    setArtifactContent(undefined);
  }, [taskId]);

  if (detail.loading && !detail.data) return <SkeletonDetail />;
  if (detail.error && !detail.data) {
    return <ErrorBanner error={detail.error} onRetry={detail.reload} />;
  }
  if (!detail.data) return null;

  const { task, runs, artifacts, events, open_question: openQuestionItem } = detail.data;
  const badge = STATUS_BADGE[task.status];
  const canStop =
    task.status === "running" || task.status === "queued" || task.status === "needs_input";
  const canRetry = task.status === "interrupted" || task.status === "failed";
  const questionText =
    typeof openQuestionItem?.custom["question"] === "string"
      ? openQuestionItem.custom["question"]
      : "The worker paused and asked for clarification before continuing.";

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await api.retryTask(task.id);
      onToast("Queued again");
      detail.reload();
      onUpdated();
    } catch (err) {
      onToast(`Retry failed: ${(err as Error).message}`, "err");
    } finally {
      setRetrying(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      const { task: stopped } = await api.cancelTask(task.id, "Stopped by Sandip in Command Centre");
      onToast(stopped.status === "cancelled" ? "Task stopped" : `Task had already ${stopped.status}`);
      detail.reload();
      onUpdated();
    } catch (err) {
      onToast(`Stop failed: ${(err as Error).message}`, "err");
    } finally {
      setStopping(false);
    }
  };

  const handleAnswer = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = answer.trim();
    if (!trimmed || submittingAnswer) return;
    setSubmittingAnswer(true);
    try {
      await api.answerTask(task.id, {
        answer: trimmed,
        expected_revision: task.revision,
        ...(openQuestionItem ? { question_id: openQuestionItem.id } : {}),
      });
      setAnswer("");
      onToast("Answer sent; the task resumes shortly");
      detail.reload();
      onUpdated();
    } catch (err) {
      onToast(`Could not answer task: ${(err as Error).message}`, "err");
    } finally {
      setSubmittingAnswer(false);
    }
  };

  const openArtifact = async (artifact: Artifact) => {
    setSelectedArtifact(artifact);
    setLoadingArtifact(true);
    try {
      const content = await api.getArtifactContent(artifact.id);
      setArtifactContent(content);
    } catch (err) {
      setArtifactContent(`Failed to load artifact content: ${(err as Error).message}`);
    } finally {
      setLoadingArtifact(false);
    }
  };

  return (
    <div className="detail-inner">
      <div className="d-src">
        Task <code>{task.id}</code> · lane <b>{task.lane}</b> · rev <code>r{task.revision}</code>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <h2 className="d-title" style={{ flex: 1 }}>
          {task.goal}
        </h2>
        {canStop ? (
          <Button small pending={stopping} disabled={stopping} onClick={() => void handleStop()}>
            Stop
          </Button>
        ) : null}
        {canRetry ? (
          <Button small pending={retrying} disabled={retrying} onClick={() => void handleRetry()}>
            Retry
          </Button>
        ) : null}
      </div>

      <div className="d-meta">
        <Badge spec={badge} />
        <Badge spec={{ label: `runner: ${task.runner}`, variant: "neutral" }} />
        <Badge spec={{ label: `started ${relativeTime(task.created_at)}`, variant: "neutral" }} />
      </div>

      {task.result_summary ? (
        <div className="d-why">
          <b>Summary:</b> {task.result_summary}
        </div>
      ) : null}

      {task.status === "failed" && task.result_summary ? (
        <ErrorStrip message={`Task failed: ${task.result_summary}`} />
      ) : null}

      {task.status === "awaiting_review" ? (
        <div className="d-why">
          The worker proposed items for you.{" "}
          <button type="button" className="linkish" onClick={() => navigate("/inbox")}>
            Review them in the Inbox
          </button>
        </div>
      ) : null}

      {task.status === "needs_input" && openQuestionItem ? (
        <form className="dcard" onSubmit={(e) => void handleAnswer(e)}>
          <h4>Clarification Needed (Worker Paused)</h4>
          <p className="detail-text" style={{ marginTop: 0 }}>
            {questionText}
          </p>
          <textarea
            className="draft short"
            rows={3}
            placeholder="Write your clarification to resume the worker..."
            value={answer}
            disabled={submittingAnswer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
            <Button
              type="submit"
              variant="good"
              small
              pending={submittingAnswer}
              disabled={submittingAnswer || !answer.trim()}
            >
              Submit Answer &amp; Resume
            </Button>
            {openQuestionItem ? (
              <button
                type="button"
                className="link"
                style={{ fontSize: 12, color: "var(--core)", background: "none", border: 0, cursor: "pointer" }}
                onClick={() => navigate(`/inbox/${encodeURIComponent(openQuestionItem.id)}`)}
              >
                View question in Inbox
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      <div className="dcard">
        <h4>Scoped Artifacts ({artifacts.length})</h4>
        <div className="mode-note" style={{ marginTop: 0, marginBottom: 10 }}>
          Confined to <code>~/.samaritan/artifacts/{task.id}/</code>
        </div>
        {artifacts.length === 0 ? (
          <div className="detail-text" style={{ color: "var(--muted)" }}>
            No artifacts produced yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {artifacts.map((art) => (
              <div
                key={art.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 10px",
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  background: selectedArtifact?.id === art.id ? "var(--core-soft)" : "var(--list-bg)",
                }}
              >
                <div>
                  <b>{art.path_or_url.split("/").pop() ?? art.path_or_url}</b>{" "}
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    ({art.kind} · {art.media_type} · <code>{art.content_hash.slice(0, 18)}</code>)
                  </span>
                </div>
                <Button small onClick={() => void openArtifact(art)}>
                  Preview
                </Button>
              </div>
            ))}
          </div>
        )}

        {selectedArtifact ? (
          <div className="quote" style={{ marginTop: 12 }}>
            <div className="from">
              Preview: <code>{selectedArtifact.path_or_url}</code> (
              <code>{selectedArtifact.content_hash.slice(0, 19)}</code>)
            </div>
            {loadingArtifact ? "Loading artifact..." : artifactContent}
          </div>
        ) : null}
      </div>

      <div className="dcard">
        <h4>Runs ({runs.length})</h4>
        {runs.length === 0 ? (
          <div className="detail-text" style={{ color: "var(--muted)" }}>
            No runs recorded.
          </div>
        ) : (
          runs.map((run) => (
            <div key={run.id} className="frow" style={{ alignItems: "center" }}>
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
              <span style={{ flex: 1 }}>
                <code>{run.id}</code> · {run.runner} · <b>{run.status}</b> (gen{" "}
                <code>{run.fencing_generation}</code>)
              </span>
              <span className="tm">{clockTime(run.started_at)}</span>
            </div>
          ))
        )}
      </div>

      <div className="dcard">
        <h4>Activity Stream ({events.length})</h4>
        {events.length === 0 ? (
          <div className="detail-text" style={{ color: "var(--muted)" }}>
            No activity events yet.
          </div>
        ) : (
          <div className="audit">
            {events.map((ev) => (
              <div
                key={ev.id}
                className={
                  ev.type === "run.completed"
                    ? "arow terminal"
                    : ev.type === "run.failed" || ev.type === "run.cancelled"
                      ? "arow problem"
                      : "arow"
                }
              >
                <div className="headline">
                  <code>{ev.type}</code>{" "}
                  <span className="from">· {clockTime(ev.created_at)}</span>
                </div>
                <div className="sub">
                  {Object.keys(ev.payload).length > 0 ? (
                    <code className="wrap">{JSON.stringify(ev.payload)}</code>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
