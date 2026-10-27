/**
 * App shell navigation (Command Centre IA: Now, Inbox, Tasks, Activity, Settings).
 *
 * The Ask / Delegate box supports two modes:
 *  - Ask Recall: navigates to `/ask#<question>` so the cited answer renders in the main pane.
 *  - Delegate Task: submits a goal directly to the Worker Adapter (`POST /api/tasks`) and
 *    navigates to `/tasks/:id`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { TaskLane } from "../api/types";
import { linkHandler, navigate, type ViewName } from "../lib/router";

interface NavItem {
  view: ViewName;
  href: string;
  label: string;
  count?: number;
}

export function Sidebar({
  active,
  inboxCount,
  tasksCount,
  deferredCount,
  statusLine,
  askQuery = "",
  onTaskCreated,
  onToast,
}: {
  active: ViewName;
  inboxCount: number | undefined;
  tasksCount?: number | undefined;
  deferredCount: number | undefined;
  statusLine: string;
  /** The question currently on screen, so the box reflects a deep-linked ask. */
  askQuery?: string;
  onTaskCreated?: () => void;
  onToast?: (message: string, variant?: "ok" | "err") => void;
}) {
  const items: NavItem[] = [
    { view: "dashboard", href: "/now", label: "Now" },
    {
      view: "inbox",
      href: "/inbox",
      label: "Inbox",
      ...(inboxCount !== undefined ? { count: inboxCount } : {}),
    },
    {
      view: "tasks",
      href: "/tasks",
      label: "Tasks",
      ...(tasksCount !== undefined ? { count: tasksCount } : {}),
    },
    { view: "activity", href: "/activity", label: "Activity" },
    { view: "settings", href: "/settings", label: "Settings" },
  ];

  const [mode, setMode] = useState<"ask" | "delegate">("ask");
  const [lane, setLane] = useState<TaskLane>("general");
  const [draft, setDraft] = useState(askQuery);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (askQuery) {
      setMode("ask");
      setDraft(askQuery);
    }
  }, [askQuery]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || submitting) return;

    if (mode === "ask") {
      navigate(`/ask#${encodeURIComponent(text)}`);
      return;
    }

    setSubmitting(true);
    try {
      const created = await api.createTask({ goal: text, lane });
      setDraft("");
      onTaskCreated?.();
      onToast?.(`Delegated task started (${lane})`);
      navigate(`/tasks/${encodeURIComponent(created.task.id)}`);
    } catch (err) {
      onToast?.(`Could not start task: ${(err as Error).message}`, "err");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <aside className="side">
      <div className="brand">
        <div className="lg" aria-hidden="true" />
        <b>Samaritan</b>
      </div>

      <nav className="nav" aria-label="Main">
        {items.map((item) => {
          const isActive =
            active === item.view ||
            (item.view === "inbox" && active === "deferred") ||
            (item.view === "activity" && active === "completed");
          return (
            <a
              key={item.view}
              href={item.href}
              className={isActive ? "active" : ""}
              onClick={linkHandler(item.href)}
              aria-current={isActive ? "page" : undefined}
            >
              <span>{item.label}</span>
              {item.count !== undefined && item.count > 0 ? (
                <span className="n">{item.count}</span>
              ) : null}
            </a>
          );
        })}
        {deferredCount !== undefined && deferredCount > 0 ? (
          <a
            href="/deferred"
            className={active === "deferred" ? "active" : ""}
            onClick={linkHandler("/deferred")}
            style={{ fontSize: "12.5px", paddingLeft: "20px", opacity: 0.85 }}
          >
            <span>Deferred</span>
            <span className="n">{deferredCount}</span>
          </a>
        ) : null}
      </nav>

      <div className="spacer" />

      <form className="ask" onSubmit={(e) => void submit(e)} role="search">
        <div className="cmd-mode-row">
          <button
            type="button"
            className={mode === "ask" ? "cmd-pill active" : "cmd-pill"}
            onClick={() => setMode("ask")}
          >
            Ask Recall
          </button>
          <button
            type="button"
            className={mode === "delegate" ? "cmd-pill active" : "cmd-pill"}
            onClick={() => setMode("delegate")}
          >
            Delegate Task
          </button>
        </div>
        <label className="ask-label" htmlFor="ask-input">
          {mode === "ask" ? "Ask Samaritan" : "Delegate to Worker"}
        </label>
        <input
          id="ask-input"
          className="ask-input"
          type="search"
          placeholder={
            mode === "ask"
              ? "Ask about your notes..."
              : "Describe a goal to delegate..."
          }
          value={draft}
          disabled={submitting}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={
            mode === "ask"
              ? "Ask Samaritan a question about your notes, journals and decisions"
              : "Delegate a background task to Samaritan worker"
          }
        />
        {mode === "delegate" ? (
          <div className="cmd-delegate-bar">
            <select
              className="cmd-lane-select"
              value={lane}
              aria-label="Task lane"
              onChange={(e) => setLane(e.target.value as TaskLane)}
            >
              <option value="general">general</option>
              <option value="coding">coding</option>
              <option value="research">research</option>
              <option value="operations">operations</option>
            </select>
            <button type="submit" className="cmd-submit-btn" disabled={submitting || !draft.trim()}>
              {submitting ? "Starting..." : "Run"}
            </button>
          </div>
        ) : null}
      </form>

      <small>{statusLine}</small>
    </aside>
  );
}
