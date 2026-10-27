/**
 * Worker Adapter and Delegated Task Service (PROPOSAL D1).
 *
 * Implements the 5-method `WorkerAdapter` interface (`start`, `events`,
 * `answer`, `cancel`, `status`). Workers run with Rule-of-Two isolation: they
 * can read Recall, write files inside their scoped `~/.samaritan/artifacts/<task-id>/`
 * directory, ask a clarifying question (`task-question` in the Inbox), or
 * propose an `ActionItem` (`task-action-proposal` in the Inbox), but they hold
 * no external write/send credentials. Every mutation is fenced by the active
 * run's lease token.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { ActionCenterError, type ActionCenter } from "../action-center/index.js";
import { expandPath } from "../config/index.js";
import { log } from "../logger.js";
import type { RecallService } from "../recall/service.js";
import {
  getActionItem,
  listActionItems,
  transition,
} from "../store/action-items.js";
import type { Db } from "../store/db.js";
import {
  admitRun,
  assertLeaseValid,
  fenceRun,
  finishRun,
  getRun,
  listRuns,
  StaleLeaseError,
} from "../store/runs.js";
import {
  appendActivityEvent,
  createTask,
  getArtifact,
  getTask,
  listActivityEvents,
  listArtifacts,
  listTasks,
  registerArtifact,
  updateTask,
} from "../store/tasks.js";
import {
  cancelRun,
  registerActiveRun,
  unregisterActiveRun,
} from "../run-layer/index.js";
import type {
  ActivityEvent,
  Artifact,
  ArtifactKind,
  DraftActionItem,
  RunRecord,
  Task,
  TaskLane,
} from "../types/index.js";

const logger = log("worker");

export interface WorkerRunContext {
  admission_key?: string;
  answers?: string[];
  inputs?: Record<string, unknown>;
}

export interface WorkerTools {
  readonly task: Task;
  readonly run: RunRecord;
  readonly artifactDir: string;
  recall(question: string): Promise<{ answer: string; citations: { kind: string; ref: string; excerpt?: string }[] }>;
  recordToolCall(tool: string, args: Record<string, unknown>, summary?: string): void;
  writeArtifact(input: {
    filename: string;
    content: string;
    kind?: ArtifactKind;
    media_type?: string;
  }): Artifact;
  askQuestion(question: string, contextSummary?: string): Promise<{ action_item_id: string }>;
  proposeAction(proposal: {
    kind: "decision" | "insight" | "task" | "person" | "note";
    title: string;
    detail?: string;
    project?: string;
    owner?: string;
    due?: string;
    evidence?: string;
  }): Promise<{ action_item_id: string }>;
  isCancelled(): boolean;
}

export interface WorkerExecutionOutcome {
  status: "succeeded" | "needs_input" | "awaiting_review" | "failed";
  summary: string;
  cost_usd?: number;
}

export type WorkerExecutor = (
  tools: WorkerTools,
  context: WorkerRunContext,
) => Promise<WorkerExecutionOutcome>;

/**
 * The 5-method WorkerAdapter contract (PROPOSAL D1).
 */
export interface WorkerAdapter {
  start(task: Task, context?: WorkerRunContext): Promise<RunRecord>;
  events(cursor?: number, taskId?: string): ActivityEvent[];
  answer(questionOrTaskId: string, answerText: string, expectedRevision?: number): Promise<Task>;
  cancel(runOrTaskId: string, reason?: string): Promise<RunRecord | undefined>;
  status(runId: string): Promise<RunRecord | undefined>;
}

export interface WorkerServiceDeps {
  db: Db;
  actionCenter: ActionCenter;
  recall?: RecallService;
  artifactsRoot?: string;
  executor?: WorkerExecutor;
}

/**
 * Resolves a relative filename inside `<artifactsRoot>/<taskId>`, refusing any
 * path traversal outside the task's scoped directory.
 */
export function resolveTaskArtifactPath(
  artifactsRoot: string,
  taskId: string,
  relativePath: string,
): string {
  const taskDir = resolve(artifactsRoot, taskId);
  const target = resolve(taskDir, normalize(relativePath));
  if (target !== taskDir && !target.startsWith(`${taskDir}/`)) {
    throw new Error(`artifact path "${relativePath}" escapes task directory ${taskDir}`);
  }
  return target;
}

/**
 * Default built-in worker executor. Searches Recall for the task's goal, writes
 * a cited markdown brief into the task's scoped artifact folder, and completes.
 * If the goal explicitly asks a question or requests a proposal via inputs,
 * exercises those paths deterministically.
 */
async function defaultWorkerExecutor(
  tools: WorkerTools,
  context: WorkerRunContext,
): Promise<WorkerExecutionOutcome> {
  const { task } = tools;
  const askPrompt = context.inputs?.["ask_question"] as string | undefined;
  if (askPrompt && (!context.answers || context.answers.length === 0)) {
    await tools.askQuestion(
      askPrompt,
      String(context.inputs?.["context_summary"] ?? `Clarification needed for: ${task.goal}`),
    );
    return {
      status: "needs_input",
      summary: `Waiting for answer: ${askPrompt}`,
    };
  }

  tools.recordToolCall("recall.query", { question: task.goal });
  const recallRes = await tools.recall(task.goal);

  const lines = [
    `# Task Artifact: ${task.goal}`,
    "",
    `- **Task ID**: \`${task.id}\``,
    `- **Lane**: \`${task.lane}\``,
    `- **Revision**: \`v${task.revision}\``,
    ...(context.answers?.length
      ? ["", "## Clarifications Provided", ...context.answers.map((a) => `- ${a}`)]
      : []),
    "",
    "## Findings",
    recallRes.answer || "Completed local recall scan.",
    "",
    "## Citations",
    ...(recallRes.citations.length
      ? recallRes.citations.map((c) => `- **[${c.kind}]** \`${c.ref}\`: ${c.excerpt ?? ""}`)
      : ["- No matching indexed passages."]),
  ];

  const artifact = tools.writeArtifact({
    filename: `brief-rev-${task.revision}.md`,
    content: lines.join("\n"),
    kind: "brief",
  });

  const propose = context.inputs?.["propose_action"] as
    | {
        kind: "decision" | "insight" | "task" | "person" | "note";
        title: string;
        detail?: string;
        project?: string;
        owner?: string;
        due?: string;
        evidence?: string;
      }
    | undefined;

  if (propose) {
    await tools.proposeAction(propose);
    return {
      status: "awaiting_review",
      summary: `Proposed ${propose.kind} "${propose.title}" for review in Inbox (artifact: ${artifact.path_or_url})`,
    };
  }

  return {
    status: "succeeded",
    summary: `Generated cited brief (${recallRes.citations.length} citation(s)) at ${artifact.path_or_url}`,
  };
}

export class WorkerService implements WorkerAdapter {
  readonly #db: Db;
  readonly #actionCenter: ActionCenter;
  readonly #recall: RecallService | undefined;
  readonly #artifactsRoot: string;
  #executor: WorkerExecutor;

  constructor(deps: WorkerServiceDeps) {
    this.#db = deps.db;
    this.#actionCenter = deps.actionCenter;
    this.#recall = deps.recall;
    this.#artifactsRoot =
      deps.artifactsRoot ?? expandPath("~/.samaritan/artifacts");
    this.#executor = deps.executor ?? defaultWorkerExecutor;
  }

  /** Test seam to swap the worker executor behavior at runtime. */
  setExecutor(executor: WorkerExecutor): void {
    this.#executor = executor;
  }

  /**
   * Submits a new delegated task and starts its worker run unless `autoStart: false`.
   */
  async submit(input: {
    id?: string;
    goal: string;
    lane?: TaskLane;
    scope?: "work" | "personal";
    parent_task_id?: string | null;
    admission_key?: string;
    inputs?: Record<string, unknown>;
    autoStart?: boolean;
  }): Promise<{ task: Task; run?: RunRecord }> {
    const task = createTask(this.#db, {
      ...(input.id ? { id: input.id } : {}),
      goal: input.goal,
      ...(input.lane ? { lane: input.lane } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.parent_task_id !== undefined ? { parent_task_id: input.parent_task_id } : {}),
    });

    if (input.autoStart === false) {
      return { task };
    }

    const run = await this.start(task, {
      ...(input.admission_key ? { admission_key: input.admission_key } : {}),
      ...(input.inputs ? { inputs: input.inputs } : {}),
    });

    return { task: getTask(this.#db, task.id) ?? task, run };
  }

  async start(task: Task, context: WorkerRunContext = {}): Promise<RunRecord> {
    const admissionKey =
      context.admission_key ?? `task:${task.id}:rev-${task.revision}`;
    const { admitted, run } = admitRun(this.#db, {
      task_id: task.id,
      runner: "worker",
      admission_key: admissionKey,
      lease_ttl_ms: 10 * 60_000,
    });

    if (!admitted) {
      logger.info({ taskId: task.id, admissionKey, runId: run.id }, "worker run deduplicated");
      return run;
    }

    updateTask(this.#db, task.id, { status: "running" });

    const taskDir = resolve(this.#artifactsRoot, task.id);
    mkdirSync(taskDir, { recursive: true });

    const leaseToken = run.lease_token!;
    const leaseGen = run.fencing_generation;
    let cancelled = false;
    let cancelReject: ((err: Error) => void) | undefined;
    const cancelPromise = new Promise<never>((_, reject) => {
      cancelReject = reject;
    });

    registerActiveRun(run.id, {
      abort: (reason: string) => {
        cancelled = true;
        cancelReject?.(new StaleLeaseError(run.id, reason));
      },
    });

    const tools: WorkerTools = {
      task,
      run,
      artifactDir: taskDir,
      isCancelled: () => cancelled,
      recall: async (question: string) => {
        assertLeaseValid(this.#db, run.id, leaseToken, leaseGen);
        if (!this.#recall) {
          return { answer: "", citations: [] };
        }
        const res = await this.#recall.query(question);
        return {
          answer: res.answer ?? "",
          citations: res.citations,
        };
      },
      recordToolCall: (tool: string, args: Record<string, unknown>, summary?: string) => {
        assertLeaseValid(this.#db, run.id, leaseToken, leaseGen);
        appendActivityEvent(this.#db, {
          task_id: task.id,
          run_id: run.id,
          type: "tool.called",
          payload: { tool, args, ...(summary ? { summary } : {}) },
        });
      },
      writeArtifact: (artInput) => {
        assertLeaseValid(this.#db, run.id, leaseToken, leaseGen);
        const absPath = resolveTaskArtifactPath(
          this.#artifactsRoot,
          task.id,
          artInput.filename,
        );
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, artInput.content, "utf8");
        const hash = `sha256:${createHash("sha256").update(artInput.content).digest("hex")}`;
        return registerArtifact(this.#db, {
          task_id: task.id,
          run_id: run.id,
          kind: artInput.kind ?? "file",
          path_or_url: absPath,
          content_hash: hash,
          ...(artInput.media_type ? { media_type: artInput.media_type } : {}),
        });
      },
      askQuestion: async (question: string, contextSummary = "") => {
        assertLeaseValid(this.#db, run.id, leaseToken, leaseGen);
        const draft: DraftActionItem = {
          capability_id: "worker-task",
          type: "task-question",
          task_id: task.id,
          run_id: run.id,
          context: {
            what_happened: `Delegated task "${task.goal}" needs clarification`,
            source: { kind: "worker", id: task.id },
            provenance: ["worker.askQuestion"],
            why_flagged: "worker cannot proceed without your input",
            trigger_reason: "policy",
            confidence: 0.95,
            decision_needed: question,
            decision_surface: "inbox",
            execution_surface: "samaritan",
            outcome_preview: `Sends your answer to task ${task.id} and resumes the worker`,
          },
          custom: {
            task_id: task.id,
            run_id: run.id,
            lane: task.lane,
            question,
            context_summary: contextSummary,
            answer: "",
          },
          dedupe_key: `worker-question:${task.id}:rev-${task.revision}`,
        };

        const ingested = await this.#actionCenter.ingest("worker-task", [draft]);
        const itemId = ingested.accepted[0]?.id ?? "";

        appendActivityEvent(this.#db, {
          task_id: task.id,
          run_id: run.id,
          type: "question.asked",
          payload: { question, action_item_id: itemId, revision: task.revision },
        });

        updateTask(this.#db, task.id, {
          status: "needs_input",
          result_summary: `Question: ${question}`,
        });

        return { action_item_id: itemId };
      },
      proposeAction: async (proposal) => {
        assertLeaseValid(this.#db, run.id, leaseToken, leaseGen);
        const draft: DraftActionItem = {
          capability_id: "worker-task",
          type: "task-action-proposal",
          task_id: task.id,
          run_id: run.id,
          context: {
            what_happened: `Worker task "${task.goal}" proposed a ${proposal.kind}`,
            source: { kind: "worker", id: task.id },
            provenance: ["worker.proposeAction"],
            why_flagged: "delegated worker proposals always require review before execution",
            trigger_reason: "policy",
            confidence: 0.85,
            decision_needed: `Approve ${proposal.kind}: "${proposal.title}"?`,
            decision_surface: "inbox",
            execution_surface:
              proposal.kind === "task"
                ? "ticktick"
                : proposal.kind === "note"
                  ? "obsidian"
                  : "notion",
            outcome_preview: `Files "${proposal.title}" as a ${proposal.kind}`,
          },
          custom: {
            kind: proposal.kind,
            title: proposal.title,
            detail: proposal.detail ?? "",
            project: proposal.project ?? "",
            owner: proposal.owner ?? "",
            due: proposal.due ?? "",
            evidence: proposal.evidence ?? "",
            task_id: task.id,
            run_id: run.id,
          },
          dedupe_key: `worker-proposal:${task.id}:${proposal.kind}:${proposal.title}`,
        };

        const ingested = await this.#actionCenter.ingest("worker-task", [draft]);
        const itemId = ingested.accepted[0]?.id ?? "";

        appendActivityEvent(this.#db, {
          task_id: task.id,
          run_id: run.id,
          type: "action.proposed",
          payload: {
            action_item_id: itemId,
            kind: proposal.kind,
            title: proposal.title,
          },
        });

        updateTask(this.#db, task.id, {
          status: "awaiting_review",
          result_summary: `Proposed ${proposal.kind}: ${proposal.title}`,
        });

        return { action_item_id: itemId };
      },
    };

    try {
      const outcome = await Promise.race([
        this.#executor(tools, context),
        cancelPromise,
      ]);
      assertLeaseValid(this.#db, run.id, leaseToken, leaseGen);

      const finalRun = finishRun(this.#db, run.id, leaseToken, {
        status: outcome.status === "failed" ? "failed" : "succeeded",
        ...(outcome.status === "failed" ? { error: outcome.summary } : {}),
        ...(outcome.cost_usd !== undefined ? { cost_usd: outcome.cost_usd } : {}),
      });

      updateTask(this.#db, task.id, {
        status: outcome.status,
        result_summary: outcome.summary,
      });

      return finalRun;
    } catch (err) {
      if (err instanceof StaleLeaseError || cancelled) {
        const fenced = fenceRun(this.#db, run.id, "cancelled", (err as Error).message);
        updateTask(this.#db, task.id, {
          status: "cancelled",
          result_summary: (err as Error).message,
        });
        return fenced ?? getRun(this.#db, run.id)!;
      }

      const message = err instanceof Error ? err.message : String(err);
      try {
        const failedRun = finishRun(this.#db, run.id, leaseToken, {
          status: "failed",
          error: message,
        });
        updateTask(this.#db, task.id, {
          status: "failed",
          result_summary: message,
        });
        return failedRun;
      } catch {
        const fenced = fenceRun(this.#db, run.id, "cancelled", message);
        return fenced ?? getRun(this.#db, run.id)!;
      }
    } finally {
      unregisterActiveRun(run.id);
    }
  }

  events(cursor = 0, taskId?: string): ActivityEvent[] {
    return listActivityEvents(this.#db, {
      after_cursor: cursor,
      ...(taskId ? { task_id: taskId } : {}),
    });
  }

  async answer(
    questionOrTaskId: string,
    answerText: string,
    expectedRevision?: number,
  ): Promise<Task> {
    let task = getTask(this.#db, questionOrTaskId);
    let questionItem = task
      ? listActionItems(this.#db, {
          task_id: task.id,
          type: "task-question",
          status: ["pending", "in_review"],
        })[0]
      : getActionItem(this.#db, questionOrTaskId);

    if (!task && questionItem?.task_id) {
      task = getTask(this.#db, questionItem.task_id);
    }

    if (!task) {
      throw new ActionCenterError(
        `task or question "${questionOrTaskId}" not found`,
        "not_found",
        404,
      );
    }

    if (expectedRevision !== undefined && task.revision !== expectedRevision) {
      throw new ActionCenterError(
        `task ${task.id} revision mismatch (expected v${expectedRevision}, current v${task.revision})`,
        "stale_revision",
        409,
      );
    }

    if (questionItem && (questionItem.status === "pending" || questionItem.status === "in_review")) {
      transition(this.#db, {
        id: questionItem.id,
        to: "approved",
        actor: "sandip",
        reason: "answered worker question",
        patch: {
          custom: { ...questionItem.custom, answer: answerText },
        },
      });
      transition(this.#db, {
        id: questionItem.id,
        to: "executed",
        actor: "system",
        reason: "answer delivered to worker",
      });
    }

    const updated = updateTask(this.#db, task.id, {
      status: "running",
      bumpRevision: true,
      result_summary: `Resumed with answer: ${answerText}`,
    });

    appendActivityEvent(this.#db, {
      task_id: updated.id,
      type: "question.answered",
      payload: {
        answer: answerText,
        revision: updated.revision,
        ...(questionItem ? { action_item_id: questionItem.id } : {}),
      },
    });

    await this.start(updated, {
      admission_key: `task:${updated.id}:rev-${updated.revision}`,
      answers: [answerText],
    });

    return getTask(this.#db, updated.id) ?? updated;
  }

  async cancel(runOrTaskId: string, reason = "cancelled by user"): Promise<RunRecord | undefined> {
    let run = getRun(this.#db, runOrTaskId);
    if (!run) {
      const taskRuns = listRuns(this.#db, { task_id: runOrTaskId, status: "running", limit: 1 });
      run = taskRuns[0] ?? listRuns(this.#db, { task_id: runOrTaskId, limit: 1 })[0];
    }

    const taskId = run?.task_id ?? (getTask(this.#db, runOrTaskId) ? runOrTaskId : undefined);
    const cancelledRun = run ? cancelRun(this.#db, run.id, reason) : undefined;

    if (taskId) {
      const task = getTask(this.#db, taskId);
      if (task && task.status !== "succeeded" && task.status !== "cancelled") {
        updateTask(this.#db, taskId, {
          status: "cancelled",
          result_summary: reason,
        });
      }
    }

    return cancelledRun;
  }

  async status(runId: string): Promise<RunRecord | undefined> {
    return getRun(this.#db, runId);
  }

  listTasks(filter: Parameters<typeof listTasks>[1] = {}): Task[] {
    return listTasks(this.#db, filter);
  }

  getTask(id: string): Task | undefined {
    return getTask(this.#db, id);
  }

  listArtifacts(filter: Parameters<typeof listArtifacts>[1] = {}): Artifact[] {
    return listArtifacts(this.#db, filter);
  }

  getArtifact(id: string): { artifact: Artifact; content?: string } | undefined {
    const artifact = getArtifact(this.#db, id);
    if (!artifact) return undefined;
    let content: string | undefined;
    if (artifact.kind !== "url" && existsSync(artifact.path_or_url)) {
      try {
        content = readFileSync(artifact.path_or_url, "utf8");
      } catch {
        content = undefined;
      }
    }
    return { artifact, ...(content !== undefined ? { content } : {}) };
  }
}

export {
  createChildProcessWorkerExecutor,
  sanitizeWorkerEnv,
  type ChildWorkerOptions,
} from "./child-worker.js";
