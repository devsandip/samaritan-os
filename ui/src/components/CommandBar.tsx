/**
 * CommandBar (`COMMAND-CENTRE-SPEC P2-2`).
 *
 * Global `Cmd+K` / `Ctrl+K` quick-action modal for asking Recall, delegating a
 * background task (`general` / `coding` / `research` / `operations`), or
 * jumping between the 5 Command Centre views.
 */
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api/client";
import type { TaskLane } from "../api/types";
import { Button } from "./primitives";
import { navigate } from "../lib/router";

export function CommandBar({
  onTaskCreated,
  onToast,
}: {
  onTaskCreated?: () => void;
  onToast?: (message: string, variant?: "ok" | "err") => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"task" | "ask">("task");
  const [input, setInput] = useState("");
  const [lane, setLane] = useState<TaskLane>("general");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    if (mode === "ask") {
      setOpen(false);
      setInput("");
      navigate(`/ask#${encodeURIComponent(trimmed)}`);
      return;
    }

    setSubmitting(true);
    try {
      await api.createTask({ goal: trimmed, lane });
      onToast?.(`Delegated ${lane} task: "${trimmed.slice(0, 48)}"`);
      setInput("");
      setOpen(false);
      onTaskCreated?.();
      navigate("/tasks");
    } catch (err) {
      onToast?.(`Failed to delegate task: ${(err as Error).message}`, "err");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.35)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        zIndex: 1000,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 92vw)", margin: 0, boxShadow: "0 18px 48px rgba(0,0,0,0.22)" }}
      >
        <h2 style={{ marginBottom: 10 }}>
          Command Bar
          <button className="link" type="button" onClick={() => setOpen(false)}>
            Esc to close
          </button>
        </h2>

        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <Button
            small
            variant={mode === "task" ? "primary" : "default"}
            onClick={() => setMode("task")}
          >
            Delegate Task
          </Button>
          <Button
            small
            variant={mode === "ask" ? "primary" : "default"}
            onClick={() => setMode("ask")}
          >
            Ask Recall
          </Button>
        </div>

        <form onSubmit={submit}>
          <input
            type="text"
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              mode === "task"
                ? "Describe the task goal for the background worker..."
                : "Ask a question across vault, journals, decisions, and audit trail..."
            }
            style={{
              width: "100%",
              padding: "9px 11px",
              borderRadius: 6,
              border: "1px solid var(--line)",
              fontSize: 13,
              marginBottom: 10,
            }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            {mode === "task" ? (
              <select
                value={lane}
                onChange={(e) => setLane(e.target.value as TaskLane)}
                aria-label="Task lane"
              >
                <option value="general">Lane: general</option>
                <option value="coding">Lane: coding</option>
                <option value="research">Lane: research</option>
                <option value="operations">Lane: operations</option>
              </select>
            ) : (
              <span className="detail-text" style={{ margin: 0 }}>
                Hybrid SQL + Vector + FTS5 retrieval
              </span>
            )}
            <Button variant="primary" type="submit" disabled={submitting || !input.trim()}>
              {submitting ? "Running..." : mode === "task" ? "Start Task" : "Search Recall"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
