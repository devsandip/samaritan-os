/**
 * Coding-Agent HTTP Hook handler (PROPOSAL Phase 1).
 *
 * Normalizes inbound hooks from Claude Code, Codex, and Gemini CLI:
 * - Waiting hooks (`Notification` with `permission_prompt` / `idle_prompt` /
 *   `agent_needs_input` / `ToolPermission`, or `PermissionRequest`) publish a
 *   `coding_agent.waiting` event so the `coding-agent` capability surfaces an
 *   Inbox card and Telegram alert.
 * - Completion/resume hooks (`Stop`, `SessionEnd`, `SubagentStop`, `AfterAgent`)
 *   auto-resolve any unsettled Inbox card for `(agent, session_id)` so Sandip
 *   never has to manually clear an alert he already answered in the terminal.
 */
import { basename } from "node:path";
import type { EventBus } from "../index.js";
import { getActionItemByDedupeKey, transition } from "../../store/action-items.js";
import type { Db } from "../../store/db.js";
import { appendActivityEvent } from "../../store/tasks.js";
import { isSettled, nowIso } from "../../types/index.js";

export interface CodingAgentHookPayload {
  /** Explicit or inferred coding assistant identifier. */
  agent?: "claude-code" | "codex" | "gemini-cli" | string;
  session_id?: string;
  sessionId?: string;
  hook_event_name?: string;
  event?: string;
  notification_type?: string;
  type?: string;
  cwd?: string;
  message?: string;
  title?: string;
  tool_name?: string;
  remote_url?: string;
  /** Loop-prevention flag passed by Claude Code Stop hooks (PROPOSAL Gap 7). */
  stop_hook_active?: boolean;
}

export interface CodingAgentHookOutcome {
  action: "waiting_surfaced" | "auto_resolved" | "recorded_only";
  agent: string;
  session_id: string;
  hook_event: string;
  resolved_action_item_id?: string;
}

const WAITING_EVENTS = new Set([
  "permission_prompt",
  "idle_prompt",
  "agent_needs_input",
  "PermissionRequest",
  "ToolPermission",
  "waiting",
]);

const RESOLVE_EVENTS = new Set([
  "Stop",
  "SessionEnd",
  "SubagentStop",
  "AfterAgent",
  "resolved",
]);

export async function handleCodingAgentHook(
  deps: { db: Db; eventBus: EventBus },
  raw: CodingAgentHookPayload,
): Promise<CodingAgentHookOutcome> {
  const sessionId = (raw.session_id ?? raw.sessionId ?? "default-session").trim();
  const hookEvent = (
    raw.notification_type ??
    raw.type ??
    raw.hook_event_name ??
    raw.event ??
    "Notification"
  ).trim();

  const agent = (
    raw.agent ??
    (raw.event === "PermissionRequest"
      ? "codex"
      : raw.type === "ToolPermission" || raw.hook_event_name === "AfterAgent"
        ? "gemini-cli"
        : "claude-code")
  ).trim();

  const cwd = raw.cwd ?? process.cwd();
  const repo = basename(cwd);
  const summary =
    raw.title ??
    raw.message ??
    (raw.tool_name
      ? `${agent} waiting for ${raw.tool_name} permission in ${repo}`
      : `${agent} (${hookEvent}) in ${repo}`);

  appendActivityEvent(deps.db, {
    capability_id: "coding-agent",
    type: "hook.received",
    payload: {
      agent,
      session_id: sessionId,
      hook_event: hookEvent,
      cwd,
      repo,
      summary,
      ...(raw.stop_hook_active !== undefined ? { stop_hook_active: raw.stop_hook_active } : {}),
    },
  });

  if (raw.stop_hook_active) {
    return {
      action: "recorded_only",
      agent,
      session_id: sessionId,
      hook_event: hookEvent,
    };
  }

  if (
    RESOLVE_EVENTS.has(hookEvent) ||
    RESOLVE_EVENTS.has(raw.hook_event_name ?? "") ||
    RESOLVE_EVENTS.has(raw.event ?? "")
  ) {
    const dedupeKey = `coding-agent:${agent}:${sessionId}`;
    const existing = getActionItemByDedupeKey(deps.db, "coding-agent", dedupeKey);
    if (existing && !isSettled(existing.status)) {
      if (existing.status !== "approved") {
        transition(deps.db, {
          id: existing.id,
          to: "approved",
          actor: "system",
          reason: `auto-resolved by ${hookEvent} hook`,
        });
      }
      transition(deps.db, {
        id: existing.id,
        to: "executed",
        actor: "system",
        reason: `session ${sessionId} emitted ${hookEvent}`,
      });
      return {
        action: "auto_resolved",
        agent,
        session_id: sessionId,
        hook_event: hookEvent,
        resolved_action_item_id: existing.id,
      };
    }

    return {
      action: "recorded_only",
      agent,
      session_id: sessionId,
      hook_event: hookEvent,
    };
  }

  if (
    WAITING_EVENTS.has(hookEvent) ||
    raw.hook_event_name === "Notification" ||
    WAITING_EVENTS.has(raw.event ?? "")
  ) {
    // Use a unique event id per waiting occurrence so a session that waits, gets
    // answered, and waits a second time is not dropped by `seen_events`.
    const eventId = `hook:${agent}:${sessionId}:${hookEvent}:${Date.now()}`;
    await deps.eventBus.publish({
      id: eventId,
      type: "coding_agent.waiting",
      source: agent,
      occurred_at: nowIso(),
      payload: {
        agent,
        session_id: sessionId,
        hook_event: hookEvent,
        cwd,
        repo,
        summary,
        detail: raw.message ?? `Session ${sessionId} is waiting in ${cwd} (${hookEvent}).`,
        remote_url: raw.remote_url ?? "",
      },
    });

    return {
      action: "waiting_surfaced",
      agent,
      session_id: sessionId,
      hook_event: hookEvent,
    };
  }

  return {
    action: "recorded_only",
    agent,
    session_id: sessionId,
    hook_event: hookEvent,
  };
}
