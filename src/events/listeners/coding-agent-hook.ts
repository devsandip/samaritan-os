/**
 * Coding-Agent HTTP Hook handler (PROPOSAL Phase 1).
 *
 * Normalizes inbound hooks from Claude Code, Codex, and Gemini CLI:
 * - Waiting hooks (`Notification` with `permission_prompt` / `idle_prompt` /
 *   `agent_needs_input` / `ToolPermission`, or `PermissionRequest`) publish a
 *   `coding_agent.waiting` event so the `coding-agent` capability surfaces an
 *   Inbox card and Telegram alert.
 * - Completion/resume hooks (`Stop`, `SessionEnd`, `AfterAgent`) retire any
 *   unsettled Inbox card for `(agent, session_id)` so Sandip never has to clear
 *   an alert he already answered in the terminal. A subagent stopping says
 *   nothing about the main session, so `SubagentStop` does not count.
 *
 * Retiring a card is not approving it: it moves to `expired` (or `executed`
 * when Sandip had already marked it handled), with the hook named as the
 * reason, so the audit trail never claims a decision nobody made (D9).
 *
 * The hook only reports a wait; answering stays in the originating client.
 * Hook payloads are untrusted text, so nothing here becomes a link or a command.
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

/**
 * Waits, per client. Claude Code sends `Notification` for many things
 * (auth_success, quota warnings and more), so only these types count.
 */
const WAITING_EVENTS = new Set([
  "permission_prompt",
  "idle_prompt",
  "agent_needs_input",
  "PermissionRequest",
  "ToolPermission",
  "waiting",
]);

const RESOLVE_EVENTS = new Set(["Stop", "SessionEnd", "AfterAgent", "resolved"]);

export async function handleCodingAgentHook(
  deps: { db: Db; eventBus: EventBus },
  raw: CodingAgentHookPayload,
): Promise<CodingAgentHookOutcome> {
  // Hook payloads are untrusted: coerce rather than assume strings.
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const sessionId = str(raw.session_id) ?? str(raw.sessionId) ?? "default-session";
  const hookEvent =
    str(raw.notification_type) ?? str(raw.type) ?? str(raw.hook_event_name) ?? str(raw.event) ?? "Notification";

  const agent =
    str(raw.agent) ??
    (raw.event === "PermissionRequest"
      ? "codex"
      : raw.type === "ToolPermission" || raw.hook_event_name === "AfterAgent"
        ? "gemini-cli"
        : "claude-code");

  const cwd = str(raw.cwd) ?? process.cwd();
  const repo = basename(cwd);
  const toolName = str(raw.tool_name);
  const summary =
    str(raw.title) ??
    str(raw.message) ??
    (toolName ? `${agent} waiting for ${toolName} permission in ${repo}` : `${agent} (${hookEvent}) in ${repo}`);

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
    if (existing && !isSettled(existing.status) && existing.status !== "approved") {
      transition(deps.db, {
        id: existing.id,
        to: existing.status === "awaiting_confirmation" ? "executed" : "expired",
        actor: "system",
        reason: `session ${sessionId} emitted ${hookEvent}; handled in the terminal`,
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

  if (WAITING_EVENTS.has(hookEvent) || WAITING_EVENTS.has(raw.event ?? "")) {
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
        detail: str(raw.message) ?? `Session ${sessionId} is waiting in ${cwd} (${hookEvent}).`,
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
