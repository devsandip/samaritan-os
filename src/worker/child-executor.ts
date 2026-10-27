/**
 * Runs a worker in a child process and proxies its tool calls (PROPOSAL D1, D9).
 *
 * This is the production `WorkerExecutor`. It forks `child.ts` (or the built
 * `child.js`), hands it the task, and answers each `tool_call` through the same
 * lease-checked `WorkerTools` an in-process executor would get. The child's
 * environment is built from scratch: PATH, HOME, a temp dir, and the model key.
 * Nothing else from the daemon's environment crosses, so neither Samaritan's
 * own secrets nor a parent Claude Code session's variables reach the agent.
 *
 * Abort means termination: SIGTERM, then SIGKILL after a grace period, and the
 * promise settles only once the process has actually exited, so the caller can
 * record that termination was verified rather than requested.
 */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../config/index.js";
import type { ArtifactKind } from "../types/index.js";
import type { ChildMessage, StartMessage, ToolCallMessage, WorkerToolName } from "./protocol.js";
import {
  WorkerAborted,
  type WorkerExecutionOutcome,
  type WorkerExecutor,
  type WorkerRunContext,
  type WorkerTools,
} from "./index.js";

export interface ChildExecutorOptions {
  apiKey: string;
  model: string;
  maxTurns: number;
  runBudgetUsd: number;
  /** Test seam: a different child script speaking the same protocol. */
  entry?: string;
  killGraceMs?: number;
}

/** `child.ts` under tsx and vitest, the compiled `child.js` under `node dist/...`. */
export function defaultChildEntry(): { entry: string; execArgv: string[] } {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith(".ts")) {
    return { entry: join(dirname(here), "child.ts"), execArgv: ["--import", "tsx"] };
  }
  return { entry: join(dirname(here), "child.js"), execArgv: [] };
}

function execArgvFor(entry: string): string[] {
  return entry.endsWith(".ts") ? ["--import", "tsx"] : [];
}

async function handleToolCall(tools: WorkerTools, call: ToolCallMessage): Promise<string> {
  const args = call.args;
  const name: WorkerToolName = call.name;
  switch (name) {
    case "search": {
      const query = String(args["query"] ?? "");
      tools.recordToolCall("search", { query });
      const res = await tools.recall(query);
      const cites = res.citations
        .map((c) => `- [${c.kind}] ${c.ref}${c.excerpt ? `: ${c.excerpt}` : ""}`)
        .join("\n");
      return `${res.answer || "No synthesised answer."}\n\nSources:\n${cites || "- none found"}`;
    }
    case "write_artifact": {
      const artifact = tools.writeArtifact({
        filename: String(args["filename"] ?? ""),
        content: String(args["content"] ?? ""),
        kind: "file" as ArtifactKind,
      });
      return `Saved ${artifact.path_or_url} (artifact ${artifact.id})`;
    }
    case "ask_question": {
      const { action_item_id } = await tools.askQuestion(
        String(args["question"] ?? ""),
        typeof args["context_summary"] === "string" ? args["context_summary"] : "",
      );
      return (
        `Question sent to Sandip (inbox item ${action_item_id}). Stop now: end your turn ` +
        `with one line saying you are waiting for his answer.`
      );
    }
    case "propose_action": {
      const kind = String(args["kind"]) as Parameters<WorkerTools["proposeAction"]>[0]["kind"];
      const { action_item_id } = await tools.proposeAction({
        kind,
        title: String(args["title"] ?? ""),
        ...(typeof args["detail"] === "string" ? { detail: args["detail"] } : {}),
        ...(typeof args["project"] === "string" ? { project: args["project"] } : {}),
        ...(typeof args["owner"] === "string" ? { owner: args["owner"] } : {}),
        ...(typeof args["due"] === "string" ? { due: args["due"] } : {}),
        ...(typeof args["evidence"] === "string" ? { evidence: args["evidence"] } : {}),
      });
      return `Proposed for review as inbox item ${action_item_id}. Nothing is filed until Sandip approves.`;
    }
  }
}

export function createChildProcessExecutor(options: ChildExecutorOptions): WorkerExecutor {
  const entry = options.entry ?? defaultChildEntry().entry;
  const graceMs = options.killGraceMs ?? 3_000;

  return (tools: WorkerTools, context: WorkerRunContext, signal: AbortSignal) =>
    new Promise<WorkerExecutionOutcome>((resolve, reject) => {
      if (!existsSync(entry)) {
        reject(new Error(`worker entry ${entry} is missing; run "pnpm build" first`));
        return;
      }

      const child: ChildProcess = fork(entry, [], {
        cwd: repoRoot(),
        execArgv: execArgvFor(entry),
        serialization: "json",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: process.env["HOME"] ?? tools.artifactDir,
          TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
          ANTHROPIC_API_KEY: options.apiKey,
          CLAUDE_AGENT_SDK_CLIENT_APP: "samaritan-worker/1.0",
        },
      });

      let outcome: WorkerExecutionOutcome | undefined;
      let abortReason: string | undefined;
      let stderrTail = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2_000);
      });

      const terminate = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, graceMs).unref();
      };

      const onAbort = () => {
        abortReason = String(signal.reason ?? "cancelled");
        terminate();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      child.on("message", (raw: ChildMessage) => {
        if (abortReason) return;
        if (raw.type === "tool_call") {
          handleToolCall(tools, raw).then(
            (value) => child.connected && child.send({ type: "tool_result", id: raw.id, ok: true, value }),
            (err: unknown) => {
              const error = err instanceof Error ? err.message : String(err);
              if (child.connected) child.send({ type: "tool_result", id: raw.id, ok: false, error });
              // A refused tool call because the lease is gone means this run no
              // longer counts. Stop it rather than let it keep spending.
              if (err instanceof Error && err.name === "StaleLeaseError") {
                abortReason = error;
                terminate();
              }
            },
          );
        } else if (raw.type === "session" || raw.type === "progress") {
          // These run inside the IPC listener, so a throw here would be an
          // uncaught exception in the daemon. A fenced lease ends the run instead.
          try {
            if (raw.type === "session") tools.recordSession(raw.session_id);
            else tools.recordProgress(raw.text);
          } catch (err) {
            abortReason = err instanceof Error ? err.message : String(err);
            terminate();
          }
        } else if (raw.type === "done") {
          outcome = {
            status: raw.status,
            summary: raw.summary,
            cost_usd: raw.cost_usd,
            ...(raw.session_id ? { session_id: raw.session_id } : {}),
          };
          // The child disconnects and exits on its own; make sure it does.
          setTimeout(terminate, graceMs).unref();
        }
      });

      child.on("error", (err) => {
        if (!outcome && !abortReason) reject(err);
      });

      child.on("exit", (code, exitSignal) => {
        signal.removeEventListener("abort", onAbort);
        if (abortReason) {
          reject(new WorkerAborted(abortReason, true));
        } else if (outcome) {
          resolve(outcome);
        } else {
          const detail = stderrTail.trim().split("\n").slice(-3).join(" | ");
          reject(
            new Error(
              `worker process exited (${exitSignal ?? `code ${code}`}) without a result` +
                (detail ? `: ${detail}` : ""),
            ),
          );
        }
      });

      const start: StartMessage = {
        type: "start",
        task: {
          id: tools.task.id,
          goal: tools.task.goal,
          lane: tools.task.lane,
          revision: tools.task.revision,
        },
        answers: context.answers ?? [],
        ...(context.resume_session_id ? { resume_session_id: context.resume_session_id } : {}),
        config: {
          model: options.model,
          max_turns: options.maxTurns,
          max_budget_usd: options.runBudgetUsd,
          cwd: tools.artifactDir,
        },
      };
      child.send(start);
    });
}
