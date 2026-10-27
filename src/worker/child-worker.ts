/**
 * Child-process worker runner (PROPOSAL-v1 D1, G4, C4).
 *
 * Runs a delegated worker inside a separate OS child process whose working
 * directory is confined to `~/.samaritan/artifacts/<task-id>/` and whose
 * environment has all external write/send credentials stripped (Rule of Two).
 * The child communicates with the parent daemon over Node IPC solely to invoke
 * fenced `WorkerTools` (`recall`, `writeArtifact`, `askQuestion`, `proposeAction`,
 * `recordToolCall`) and return its `WorkerExecutionOutcome`.
 */
import { spawn } from "node:child_process";
import type { ArtifactKind } from "../types/index.js";
import type {
  WorkerExecutionOutcome,
  WorkerExecutor,
  WorkerRunContext,
  WorkerTools,
} from "./index.js";

const FORBIDDEN_ENV_PREFIXES = [
  "NOTION_",
  "GMAIL_",
  "GOOGLE_",
  "TICKTICK_",
  "TELEGRAM_",
  "HEVY_",
  "THORNHILL_",
  "POSTHOG_",
  "FIREFLIES_",
  "SAMARITAN_SECRET_",
  "SAMARITAN_WEB_TOKEN",
  "SAMARITAN_MCP_TOKEN",
];

/**
 * Strips all external write/send credentials from an environment map so the
 * child worker process holds no direct capability to mutate external systems.
 */
export function sanitizeWorkerEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (FORBIDDEN_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
      continue;
    }
    clean[key] = value;
  }
  clean.SAMARITAN_SANDBOX = "rule_of_two";
  return clean;
}

export interface ChildWorkerOptions {
  /** Optional custom inline script for testing child-process IPC behavior. */
  script?: string;
  /** Maximum runtime in milliseconds before the child process is killed. */
  timeoutMs?: number;
}

interface ChildIpcRequest {
  id: number;
  method: "recall" | "recordToolCall" | "writeArtifact" | "askQuestion" | "proposeAction" | "done";
  params: Record<string, unknown>;
}

const DEFAULT_CHILD_SCRIPT = `
const payload = JSON.parse(process.env.SAMARITAN_WORKER_PAYLOAD || "{}");
const task = payload.task || {};
const context = payload.context || {};
const inputs = context.inputs || {};
const answers = context.answers || [];

let nextId = 1;
const pending = new Map();

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.error) entry.reject(new Error(msg.error));
  else entry.resolve(msg.result);
});

function callParent(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    process.send({ id, method, params });
  });
}

(async () => {
  try {
    if (inputs.ask_question && answers.length === 0) {
      await callParent("askQuestion", {
        question: String(inputs.ask_question),
        contextSummary: String(inputs.context_summary || ("Clarification needed for: " + task.goal)),
      });
      await callParent("done", {
        status: "needs_input",
        summary: "Waiting for answer: " + String(inputs.ask_question),
      });
      process.exit(0);
      return;
    }

    await callParent("recordToolCall", {
      tool: "recall.query",
      args: { question: task.goal },
    });
    const recallRes = await callParent("recall", { question: task.goal });
    const citations = Array.isArray(recallRes.citations) ? recallRes.citations : [];
    const lines = [
      "# Task Artifact: " + task.goal,
      "",
      "- **Task ID**: \`" + task.id + "\`",
      "- **Lane**: \`" + task.lane + "\`",
      "- **Revision**: \`v" + task.revision + "\`",
      "- **Sandbox**: \`child-process (Rule of Two)\`",
      "",
      "## Findings",
      recallRes.answer || "Completed local recall scan in isolated child process.",
      "",
      "## Citations",
      ...(citations.length
        ? citations.map((c) => "- **[" + c.kind + "]** \`" + c.ref + "\`: " + (c.excerpt || ""))
        : ["- No matching indexed passages."]),
    ];

    const artifact = await callParent("writeArtifact", {
      filename: "brief-rev-" + task.revision + ".md",
      content: lines.join("\\n"),
      kind: "brief",
    });

    if (inputs.propose_action && typeof inputs.propose_action === "object") {
      const p = inputs.propose_action;
      await callParent("proposeAction", p);
      await callParent("done", {
        status: "awaiting_review",
        summary: "Proposed " + p.kind + " \\"" + p.title + "\\" for review in Inbox (artifact: " + artifact.path_or_url + ")",
      });
      process.exit(0);
      return;
    }

    await callParent("done", {
      status: "succeeded",
      summary: "Generated cited brief (" + citations.length + " citation(s)) at " + artifact.path_or_url,
    });
    process.exit(0);
  } catch (err) {
    await callParent("done", {
      status: "failed",
      summary: err && err.message ? err.message : String(err),
    });
    process.exit(1);
  }
})();
`;

export function createChildProcessWorkerExecutor(
  options: ChildWorkerOptions = {},
): WorkerExecutor {
  const script = options.script ?? DEFAULT_CHILD_SCRIPT;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  return async (tools: WorkerTools, context: WorkerRunContext): Promise<WorkerExecutionOutcome> => {
    const cleanEnv = sanitizeWorkerEnv(process.env);
    cleanEnv.SAMARITAN_WORKER_PAYLOAD = JSON.stringify({
      task: tools.task,
      run: tools.run,
      artifactDir: tools.artifactDir,
      context,
    });

    return new Promise<WorkerExecutionOutcome>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script], {
        cwd: tools.artifactDir,
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });

      let settled = false;
      let finalOutcome: WorkerExecutionOutcome | undefined;
      let stderrBuf = "";

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
      });

      const pollTimer = setInterval(() => {
        if (tools.isCancelled() && !settled) {
          settled = true;
          clearInterval(pollTimer);
          clearTimeout(killTimer);
          child.kill("SIGTERM");
          reject(new Error("worker run cancelled"));
        }
      }, 25);
      pollTimer.unref();

      const killTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          clearInterval(pollTimer);
          child.kill("SIGTERM");
          reject(new Error(`child worker timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      killTimer.unref();

      child.on("message", (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const msg = raw as ChildIpcRequest;
        void (async () => {
          try {
            if (msg.method === "recall") {
              const result = await tools.recall(String(msg.params.question ?? ""));
              child.send({ id: msg.id, result });
            } else if (msg.method === "recordToolCall") {
              tools.recordToolCall(
                String(msg.params.tool ?? "unknown"),
                (msg.params.args as Record<string, unknown>) ?? {},
                typeof msg.params.summary === "string" ? msg.params.summary : undefined,
              );
              child.send({ id: msg.id, result: { ok: true } });
            } else if (msg.method === "writeArtifact") {
              const artifact = tools.writeArtifact({
                filename: String(msg.params.filename ?? "artifact.md"),
                content: String(msg.params.content ?? ""),
                ...(typeof msg.params.kind === "string"
                  ? { kind: msg.params.kind as ArtifactKind }
                  : {}),
                ...(typeof msg.params.media_type === "string"
                  ? { media_type: msg.params.media_type }
                  : {}),
              });
              child.send({ id: msg.id, result: artifact });
            } else if (msg.method === "askQuestion") {
              const result = await tools.askQuestion(
                String(msg.params.question ?? ""),
                typeof msg.params.contextSummary === "string" ? msg.params.contextSummary : undefined,
              );
              child.send({ id: msg.id, result });
            } else if (msg.method === "proposeAction") {
              const result = await tools.proposeAction(
                msg.params as unknown as Parameters<WorkerTools["proposeAction"]>[0],
              );
              child.send({ id: msg.id, result });
            } else if (msg.method === "done") {
              finalOutcome = {
                status:
                  (msg.params.status as WorkerExecutionOutcome["status"]) ?? "succeeded",
                summary: String(msg.params.summary ?? "completed"),
                ...(typeof msg.params.cost_usd === "number"
                  ? { cost_usd: msg.params.cost_usd }
                  : {}),
              };
              child.send({ id: msg.id, result: { ok: true } });
            }
          } catch (err) {
            if (child.connected) {
              child.send({
                id: msg.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        })();
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(killTimer);
        reject(err);
      });

      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(killTimer);
        if (finalOutcome) {
          resolve(finalOutcome);
          return;
        }
        if (code === 0) {
          resolve({ status: "succeeded", summary: "Child worker exited cleanly" });
        } else {
          resolve({
            status: "failed",
            summary: stderrBuf.trim() || `Child worker exited with code ${code ?? "unknown"}`,
          });
        }
      });
    });
  };
}
