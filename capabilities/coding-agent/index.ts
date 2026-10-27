import { basename } from "node:path";
import type { RunContext, RunResult } from "../../src/run-layer/context.js";

/**
 * Coding-Agent Waiting Monitor entrypoint.
 *
 * Converts a `coding_agent.waiting` event from Claude Code, Codex, or Gemini CLI
 * into a reviewable Inbox card keyed by `(agent, session_id)`.
 */
export async function run(context: RunContext): Promise<RunResult> {
  const payload = (context.trigger.payload ?? context.inputs ?? {}) as Record<string, unknown>;
  const agent = typeof payload["agent"] === "string" && payload["agent"] ? payload["agent"] : "claude-code";
  const sessionId = typeof payload["session_id"] === "string" && payload["session_id"] ? payload["session_id"] : "";

  if (!sessionId) {
    return {
      action_items: [],
      status: "ok",
      logs: ["no session_id in coding-agent payload; nothing to surface"],
    };
  }

  const cwd = typeof payload["cwd"] === "string" && payload["cwd"] ? payload["cwd"] : process.cwd();
  const repo = typeof payload["repo"] === "string" && payload["repo"] ? payload["repo"] : basename(cwd);
  const hookEvent =
    typeof payload["hook_event"] === "string" && payload["hook_event"]
      ? payload["hook_event"]
      : "permission_prompt";
  const summary =
    typeof payload["summary"] === "string" && payload["summary"]
      ? payload["summary"]
      : `${agent} waiting in ${repo} (${hookEvent})`;
  const detail =
    typeof payload["detail"] === "string" && payload["detail"]
      ? payload["detail"]
      : `Session ${sessionId} is waiting for input in ${cwd}.`;

  return {
    action_items: [
      {
        capability_id: "coding-agent",
        type: "coding-agent-waiting",
        context: {
          what_happened: summary,
          source: { kind: "coding-agent", id: `${agent}:${sessionId}` },
          provenance: ["coding_agent.waiting", "coding-agent.run"],
          why_flagged: `${agent} session ${sessionId} is blocked waiting on your input (${hookEvent})`,
          trigger_reason: "policy",
          confidence: 1,
          decision_needed: `Unblock ${agent} in ${repo}`,
          decision_surface: "inbox",
          execution_surface: "terminal",
          outcome_preview: `Answer it in the waiting session in ${cwd}; this card clears when it resumes`,
        },
        custom: {
          agent,
          session_id: sessionId,
          hook_event: hookEvent,
          cwd,
          repo,
          summary,
          detail,
        },
        dedupe_key: `coding-agent:${agent}:${sessionId}`,
      },
    ],
    status: "ok",
    logs: [`surfaced waiting alert for ${agent}:${sessionId}`],
  };
}
