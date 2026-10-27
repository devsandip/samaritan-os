/**
 * Delegated tasks: the ledger side of "do this for me" (PROPOSAL D1, D3, D9).
 *
 * `submit()` writes the task and returns. Nothing runs inside the request that
 * asked for it, so an MCP client, the phone and Telegram all get an answer in
 * milliseconds and follow the task through Activity. A small in-process queue
 * then admits one run per task revision, under a lease, and hands it to the
 * executor: the Claude Agent SDK in a child process in production, a plain
 * function in tests.
 *
 * What a run may do is fixed here, not by the runtime: read Recall, write files
 * inside `<artifacts>/<task-id>/`, ask Sandip a question, propose an item for
 * review. Each of those checks the lease first. A question or proposal is an
 * ordinary Inbox item, so everything that needs Sandip stays in one Inbox, and
 * answering a question goes through `ActionCenter.respond()` like any other
 * decision, with its audit row and revision check.
 *
 * Honest outcomes over resumption: a run the daemon loses in a restart is
 * marked `interrupted`, not silently re-run. A queued task that never started
 * simply starts after the restart.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import { ActionCenterError, type ActionCenter } from "../action-center/index.js";
import { expandPath, loadConfig, type Config } from "../config/index.js";
import { log } from "../logger.js";
import type { RecallService } from "../recall/service.js";
import { cancelRun, registerActiveRun, unregisterActiveRun } from "../run-layer/index.js";
import { envVarFor, getSecret } from "../secrets.js";
import { listActionItems } from "../store/action-items.js";
import type { Db } from "../store/db.js";
import {
  admitRun,
  assertLeaseValid,
  fenceRun,
  finishRun,
  getRun,
  isLeaseValid,
  listRuns,
  StaleLeaseError,
} from "../store/runs.js";
import {
  appendActivityEvent,
  createTask,
  getArtifact,
  getTask,
  getTaskByRequestKey,
  listActivityEvents,
  listArtifacts,
  listTasks,
  registerArtifact,
  updateTask,
} from "../store/tasks.js";
import type {
  ActionItem,
  ActivityEvent,
  Actor,
  Artifact,
  DraftActionItem,
  RunRecord,
  Task,
  TaskLane,
  TaskOrigin,
} from "../types/index.js";
import { createChildProcessExecutor } from "./child-executor.js";
import {
  WorkerAborted,
  type WorkerAdapter,
  type WorkerExecutor,
  type WorkerProposal,
  type WorkerRunContext,
  type WorkerTools,
} from "./types.js";

export * from "./types.js";

const logger = log("worker");

/** Open question states: still answerable from the Inbox, Tasks or Telegram. */
const OPEN_QUESTION = ["pending", "in_review", "deferred"] as const;

export interface WorkerServiceDeps {
  db: Db;
  actionCenter: ActionCenter;
  recall?: RecallService;
  artifactsRoot?: string;
  /** Test seam. Production builds the Agent SDK child executor from config at run time. */
  executor?: WorkerExecutor;
  config?: Config["worker"];
}

/**
 * Resolves a relative filename inside `<artifactsRoot>/<taskId>`, refusing any
 * path that would land outside the task's own folder.
 */
export function resolveTaskArtifactPath(
  artifactsRoot: string,
  taskId: string,
  relativePath: string,
): string {
  const taskDir = resolve(artifactsRoot, taskId);
  const target = resolve(taskDir, normalize(relativePath));
  if (target === taskDir || !target.startsWith(`${taskDir}/`)) {
    throw new Error(`artifact path "${relativePath}" escapes task directory ${taskDir}`);
  }
  return target;
}

/** First instant of the current calendar month, local time, as ISO. */
function monthStartIso(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

export class WorkerService implements WorkerAdapter {
  readonly #db: Db;
  readonly #actionCenter: ActionCenter;
  readonly #recall: RecallService | undefined;
  readonly #artifactsRoot: string;
  #executor: WorkerExecutor | undefined;
  readonly #config: Config["worker"] | undefined;
  readonly #active = new Map<string, AbortController>();
  #pumpScheduled = false;
  #stopped = false;

  constructor(deps: WorkerServiceDeps) {
    this.#db = deps.db;
    this.#actionCenter = deps.actionCenter;
    this.#recall = deps.recall;
    this.#artifactsRoot = deps.artifactsRoot ?? expandPath("~/.samaritan/artifacts");
    this.#executor = deps.executor;
    this.#config = deps.config;
  }

  get artifactsRoot(): string {
    return this.#artifactsRoot;
  }

  setExecutor(executor: WorkerExecutor | undefined): void {
    this.#executor = executor;
  }

  #cfg(): Config["worker"] {
    return this.#config ?? loadConfig().worker;
  }

  // ---- Submission ----------------------------------------------------------

  /**
   * Durably admits a task and returns at once. A repeated `request_key` (an MCP
   * client retrying, a Telegram redelivery) returns the original task.
   */
  submit(input: {
    goal: string;
    lane?: TaskLane;
    scope?: "work" | "personal";
    origin?: TaskOrigin;
    request_key?: string;
    parent_task_id?: string | null;
  }): { task: Task; created: boolean; run?: RunRecord } {
    if (input.request_key) {
      const existing = getTaskByRequestKey(this.#db, input.request_key);
      if (existing) return { task: existing, created: false };
    }
    const task = createTask(this.#db, {
      goal: input.goal,
      ...(input.lane ? { lane: input.lane } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.request_key ? { request_key: input.request_key } : {}),
      ...(input.parent_task_id !== undefined ? { parent_task_id: input.parent_task_id } : {}),
    });
    this.#schedulePump();
    return { task, created: true };
  }

  /** Re-queues a task that is queued, interrupted or failed, at a new revision. */
  start(taskId: string): Task {
    const task = this.#requireTask(taskId);
    if (task.status === "queued") {
      this.#schedulePump();
      return task;
    }
    if (task.status !== "interrupted" && task.status !== "failed") {
      throw new ActionCenterError(
        `task ${task.id} is ${task.status}; only an interrupted or failed task can be retried`,
        "task_not_retryable",
        409,
      );
    }
    const requeued = updateTask(this.#db, task.id, {
      status: "queued",
      bumpRevision: true,
      result_summary: "Retried",
    });
    appendActivityEvent(this.#db, {
      task_id: task.id,
      type: "task.retried",
      payload: { revision: requeued.revision },
    });
    this.#schedulePump();
    return requeued;
  }

  /** Called once at daemon boot, after reconciliation: start what was queued. */
  resumeQueued(): void {
    this.#schedulePump();
  }

  /** Stops dispatching and interrupts live runs (daemon shutdown). */
  stop(): void {
    this.#stopped = true;
    for (const controller of this.#active.values()) controller.abort("daemon shutting down");
  }

  /** Resolves once no run is active and nothing is waiting to be pumped. */
  async whenIdle(): Promise<void> {
    while (this.#active.size > 0 || this.#pumpScheduled) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // ---- Dispatch -------------------------------------------------------------

  #schedulePump(): void {
    if (this.#pumpScheduled || this.#stopped) return;
    this.#pumpScheduled = true;
    setImmediate(() => {
      this.#pumpScheduled = false;
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#stopped) return;
    const limit = this.#cfg().concurrency;
    while (this.#active.size < limit) {
      const next = listTasks(this.#db, { status: "queued", limit: 50 })
        .filter((t) => !this.#active.has(t.id))
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at))[0];
      if (!next) return;
      const controller = new AbortController();
      this.#active.set(next.id, controller);
      void this.#execute(next, controller)
        .catch((err) => logger.error({ taskId: next.id, err: String(err) }, "worker dispatch failed"))
        .finally(() => {
          this.#active.delete(next.id);
          this.#schedulePump();
        });
    }
  }

  #fail(task: Task, summary: string): void {
    updateTask(this.#db, task.id, { status: "failed", result_summary: summary });
    appendActivityEvent(this.#db, {
      task_id: task.id,
      type: "task.failed",
      payload: { reason: summary },
    });
  }

  #resolveExecutor(task: Task): WorkerExecutor | undefined {
    if (this.#executor) return this.#executor;
    const cfg = this.#cfg();
    const account = `anthropic:${cfg.account}`;
    const apiKey = getSecret(account);
    if (!apiKey) {
      this.#fail(
        task,
        `No API key for unattended runs. Add a Console key with ` +
          `"security add-generic-password -s samaritan -a ${account} -w", or set ${envVarFor(account)}.`,
      );
      return undefined;
    }
    return createChildProcessExecutor({
      apiKey,
      model: cfg.model,
      maxTurns: cfg.max_turns,
      runBudgetUsd: cfg.run_budget_usd,
    });
  }

  /** Worker spend this calendar month, from the runs ledger. */
  monthSpendUsd(now = new Date()): number {
    const row = this.#db
      .prepare<{ total: number | null }>(
        "SELECT SUM(cost_usd) AS total FROM runs WHERE task_id IS NOT NULL AND started_at >= ?",
      )
      .get(monthStartIso(now));
    return row?.total ?? 0;
  }

  /** What the next run needs to know: every answer so far, and the session to continue. */
  #contextFor(task: Task): WorkerRunContext {
    // after_cursor: 0 reads oldest first, which is the order answers were given in.
    const events = listActivityEvents(this.#db, { task_id: task.id, after_cursor: 0, limit: 500 });
    const answers = events
      .filter((e) => e.type === "question.answered")
      .map((e) => String(e.payload["answer"] ?? ""));
    const lastAnswer = events.filter((e) => e.type === "question.answered").at(-1);
    const lastRun = listRuns(this.#db, { task_id: task.id, limit: 1 })[0];
    const resumable =
      lastAnswer && lastRun?.remote_run_id && lastAnswer.created_at >= lastRun.started_at;
    return {
      answers,
      ...(resumable ? { resume_session_id: lastRun.remote_run_id! } : {}),
    };
  }

  async #execute(task: Task, controller: AbortController): Promise<void> {
    const cfg = this.#cfg();
    const spent = this.monthSpendUsd();
    if (cfg.monthly_budget_usd <= 0 || spent >= cfg.monthly_budget_usd) {
      this.#fail(
        task,
        `Monthly worker budget reached ($${spent.toFixed(2)} of $${cfg.monthly_budget_usd}). ` +
          `Raise worker.monthly_budget_usd in config to run more this month.`,
      );
      return;
    }

    const executor = this.#resolveExecutor(task);
    if (!executor) return;

    // Read before admitting: once this run exists it is the latest run, and the
    // session to resume belongs to the one before it.
    const context = this.#contextFor(task);
    const { admitted, run } = admitRun(this.#db, {
      task_id: task.id,
      runner: this.#executor ? "worker" : "child-process",
      admission_key: `task:${task.id}:rev-${task.revision}`,
      lease_ttl_ms: cfg.timeout_ms + 60_000,
    });
    if (!admitted) {
      // This revision already ran once. Running it again would be a silent
      // retry; say so instead and let Sandip retry explicitly.
      updateTask(this.#db, task.id, {
        status: "interrupted",
        result_summary: `Revision ${task.revision} already ran (run ${run.id}); retry to run again`,
      });
      return;
    }

    const running = updateTask(this.#db, task.id, { status: "running" });
    const taskDir = resolve(this.#artifactsRoot, task.id);
    mkdirSync(taskDir, { recursive: true });

    const leaseToken = run.lease_token!;
    const leaseGen = run.fencing_generation;
    const lease = () => assertLeaseValid(this.#db, run.id, leaseToken, leaseGen);
    let questionsAsked = 0;
    let proposals = 0;

    registerActiveRun(run.id, { abort: (reason) => controller.abort(reason) });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(`timed out after ${Math.round(cfg.timeout_ms / 1000)}s`);
    }, cfg.timeout_ms);
    timer.unref();

    const tools = this.#toolsFor(running, run, taskDir, lease, controller.signal, {
      onQuestion: () => questionsAsked++,
      onProposal: () => proposals++,
    });

    try {
      const outcome = await executor(tools, context, controller.signal);
      if (controller.signal.aborted) throw new WorkerAborted(String(controller.signal.reason), false);
      lease();
      finishRun(this.#db, run.id, leaseToken, {
        status: outcome.status,
        ...(outcome.status === "failed" ? { error: outcome.summary } : {}),
        ...(outcome.cost_usd !== undefined ? { cost_usd: outcome.cost_usd } : {}),
      });
      const status =
        outcome.status === "failed"
          ? "failed"
          : questionsAsked > 0
            ? "needs_input"
            : proposals > 0
              ? "awaiting_review"
              : "succeeded";
      updateTask(this.#db, task.id, { status, result_summary: outcome.summary.slice(0, 2_000) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = controller.signal.aborted || err instanceof WorkerAborted;
      const shutdown = aborted && String(controller.signal.reason) === "daemon shutting down";

      if (aborted || err instanceof StaleLeaseError || !isLeaseValid(this.#db, run.id, leaseToken)) {
        const fenceAs = shutdown ? "interrupted" : timedOut ? "timeout" : "cancelled";
        fenceRun(this.#db, run.id, fenceAs, message);
        if (!this.#executor) {
          // A killed SDK run never reports what it spent. Count it at its
          // ceiling so the monthly cap errs high, never low.
          this.#db.prepare("UPDATE runs SET cost_usd = ? WHERE id = ?").run(cfg.run_budget_usd, run.id);
        }
        appendActivityEvent(this.#db, {
          task_id: task.id,
          run_id: run.id,
          type: "run.exited",
          payload: { verified: err instanceof WorkerAborted && err.terminated, reason: message },
        });
        const current = getTask(this.#db, task.id);
        if (current && current.status === "running") {
          updateTask(this.#db, task.id, {
            status: shutdown ? "interrupted" : timedOut ? "failed" : "cancelled",
            result_summary: message,
          });
        }
        return;
      }

      finishRun(this.#db, run.id, leaseToken, { status: "failed", error: message });
      updateTask(this.#db, task.id, { status: "failed", result_summary: message.slice(0, 2_000) });
      logger.warn({ taskId: task.id, runId: run.id, err: message }, "worker run failed");
    } finally {
      clearTimeout(timer);
      unregisterActiveRun(run.id);
    }
  }

  #toolsFor(
    task: Task,
    run: RunRecord,
    taskDir: string,
    lease: () => void,
    signal: AbortSignal,
    counters: { onQuestion: () => void; onProposal: () => void },
  ): WorkerTools {
    const db = this.#db;
    const base = { task_id: task.id, run_id: run.id };
    return {
      task,
      run,
      artifactDir: taskDir,
      isCancelled: () => signal.aborted,
      recall: async (question) => {
        lease();
        if (!this.#recall) return { answer: "", citations: [] };
        const res = await this.#recall.query(question);
        lease();
        return { answer: res.answer ?? "", citations: res.citations };
      },
      recordToolCall: (tool, args, summary) => {
        lease();
        appendActivityEvent(db, {
          ...base,
          type: "tool.called",
          payload: { tool, args, ...(summary ? { summary } : {}) },
        });
      },
      recordProgress: (text) => {
        lease();
        appendActivityEvent(db, { ...base, type: "run.progress", payload: { text: text.slice(0, 280) } });
      },
      recordSession: (sessionId) => {
        lease();
        db.prepare("UPDATE runs SET remote_run_id = ? WHERE id = ?").run(sessionId, run.id);
      },
      writeArtifact: (input) => {
        lease();
        const absPath = resolveTaskArtifactPath(this.#artifactsRoot, task.id, input.filename);
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, input.content, "utf8");
        const artifact = registerArtifact(db, {
          ...base,
          kind: input.kind ?? "file",
          path_or_url: absPath,
          content_hash: `sha256:${createHash("sha256").update(input.content).digest("hex")}`,
          ...(input.media_type ? { media_type: input.media_type } : {}),
        });
        appendActivityEvent(db, {
          ...base,
          type: "artifact.created",
          payload: { artifact_id: artifact.id, filename: input.filename },
        });
        return artifact;
      },
      askQuestion: async (question, contextSummary = "") => {
        lease();
        const draft: DraftActionItem = {
          capability_id: "worker-task",
          type: "task-question",
          task_id: task.id,
          run_id: run.id,
          context: {
            what_happened: `Delegated task "${task.goal}" needs clarification`,
            source: { kind: "worker", id: task.id },
            provenance: ["worker.ask_question"],
            why_flagged: "the worker cannot proceed sensibly without your answer",
            trigger_reason: "policy",
            confidence: 0.95,
            decision_needed: question,
            decision_surface: "inbox",
            execution_surface: "samaritan",
            outcome_preview: "Sends your answer to the task, which then resumes",
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
        const id = await this.#ingestOne(draft);
        counters.onQuestion();
        appendActivityEvent(db, {
          ...base,
          type: "question.asked",
          payload: { question, action_item_id: id, revision: task.revision },
        });
        return { action_item_id: id };
      },
      proposeAction: async (proposal: WorkerProposal) => {
        lease();
        const draft: DraftActionItem = {
          capability_id: "worker-task",
          type: "task-action-proposal",
          task_id: task.id,
          run_id: run.id,
          context: {
            what_happened: `Delegated task "${task.goal}" proposed a ${proposal.kind}`,
            source: { kind: "worker", id: task.id },
            provenance: ["worker.propose_action"],
            why_flagged: "a delegated worker's proposals are always reviewed before anything is filed",
            trigger_reason: "policy",
            confidence: 0.85,
            decision_needed: `File this ${proposal.kind}: "${proposal.title}"?`,
            decision_surface: "inbox",
            execution_surface:
              proposal.kind === "task" ? "ticktick" : proposal.kind === "note" ? "obsidian" : "notion",
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
          dedupe_key: `worker-proposal:${task.id}:rev-${task.revision}:${proposal.kind}:${proposal.title}`,
        };
        const id = await this.#ingestOne(draft);
        counters.onProposal();
        appendActivityEvent(db, {
          ...base,
          type: "action.proposed",
          payload: { action_item_id: id, kind: proposal.kind, title: proposal.title },
        });
        return { action_item_id: id };
      },
    };
  }

  async #ingestOne(draft: DraftActionItem): Promise<string> {
    const result = await this.#actionCenter.ingest(draft.capability_id, [draft]);
    const accepted = result.accepted[0];
    if (!accepted) {
      throw new Error(
        `the Inbox refused the item: ${result.rejected[0]?.errors.join("; ") ?? "unknown reason"}`,
      );
    }
    return accepted.id;
  }

  // ---- Questions -----------------------------------------------------------

  #openQuestion(taskId: string): ActionItem | undefined {
    return listActionItems(this.#db, {
      task_id: taskId,
      type: "task-question",
      status: [...OPEN_QUESTION],
    })[0];
  }

  /**
   * Answers a task's open clarifying question, by task id or by the question's
   * Inbox item id. Only a `task-question` item on a task that is waiting for
   * input qualifies: this can never approve a proposal or revive a stopped task.
   * Given a question id, it must be the question that is open now, so a late
   * reply to an earlier question is refused rather than applied to the next.
   */
  async answer(
    taskOrQuestionId: string,
    answer: string,
    options: { actor?: Actor; expectedRevision?: number; onlyOrigin?: TaskOrigin } = {},
  ): Promise<Task> {
    let task = getTask(this.#db, taskOrQuestionId);
    let namedQuestion: string | undefined;
    if (!task) {
      const item = listActionItems(this.#db, { type: "task-question", limit: 500 }).find(
        (i) => i.id === taskOrQuestionId,
      );
      if (item?.task_id) {
        task = getTask(this.#db, item.task_id);
        namedQuestion = item.id;
      }
    }
    if (!task) {
      throw new ActionCenterError(
        `no task or clarifying question "${taskOrQuestionId}"`,
        "not_found",
        404,
      );
    }
    if (options.onlyOrigin && task.origin !== options.onlyOrigin) {
      throw new ActionCenterError(
        `task ${task.id} was not submitted over ${options.onlyOrigin}; Sandip answers it in Samaritan or Telegram`,
        "not_yours",
        403,
      );
    }
    const question = this.#openQuestion(task.id);
    if (task.status !== "needs_input" || !question) {
      throw new ActionCenterError(
        `task ${task.id} is ${task.status} and has no open question to answer`,
        "not_waiting",
        409,
      );
    }
    if (namedQuestion && namedQuestion !== question.id) {
      throw new ActionCenterError(
        "that question was already answered or replaced; answer the current one",
        "stale_question",
        409,
      );
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== task.revision) {
      throw new ActionCenterError(
        `task ${task.id} moved on (expected revision ${options.expectedRevision}, now ${task.revision})`,
        "stale_revision",
        409,
      );
    }

    await this.#actionCenter.respond(question.id, {
      response_id: "answer",
      edited_payload: { ...question.custom, answer },
      actor: options.actor ?? "sandip",
      expected_revision: question.revision,
    });
    return this.#requireTask(task.id);
  }

  /**
   * The execution side of an approved `task-question` (`samaritan.task.answer`).
   * Check-or-create on the item id, because the registry may replay an attempt.
   */
  resumeWithAnswer(input: { task_id: string; answer: string; action_item_id: string }): Task {
    const task = this.#requireTask(input.task_id);
    const already = listActivityEvents(this.#db, {
      task_id: task.id,
      type: "question.answered",
      limit: 500,
    }).some((e) => e.payload["action_item_id"] === input.action_item_id);
    if (already) return task;
    if (task.status !== "needs_input") {
      throw new Error(`task ${task.id} is ${task.status}, not waiting for an answer`);
    }
    const resumed = updateTask(this.#db, task.id, {
      status: "queued",
      bumpRevision: true,
      result_summary: "Answered; resuming",
    });
    appendActivityEvent(this.#db, {
      task_id: task.id,
      type: "question.answered",
      payload: {
        answer: input.answer,
        action_item_id: input.action_item_id,
        revision: resumed.revision,
      },
    });
    this.#schedulePump();
    return resumed;
  }

  // ---- Stop ----------------------------------------------------------------

  async cancel(taskOrRunId: string, reason = "stopped by Sandip"): Promise<Task | undefined> {
    const run = getRun(this.#db, taskOrRunId);
    const task = getTask(this.#db, run?.task_id ?? taskOrRunId);
    if (!task) {
      if (run) cancelRun(this.#db, run.id, reason);
      return undefined;
    }
    if (["succeeded", "failed", "cancelled"].includes(task.status)) return task;

    for (const live of listRuns(this.#db, { task_id: task.id, status: "running", limit: 5 })) {
      cancelRun(this.#db, live.id, reason);
    }
    const question = this.#openQuestion(task.id);
    if (question) {
      await this.#actionCenter.respond(question.id, { response_id: "reject", actor: "system" });
    }
    const cancelled = updateTask(this.#db, task.id, { status: "cancelled", result_summary: reason });
    appendActivityEvent(this.#db, { task_id: task.id, type: "task.cancelled", payload: { reason } });
    return cancelled;
  }

  // ---- Reads ---------------------------------------------------------------

  events(cursor = 0, taskId?: string): ActivityEvent[] {
    return listActivityEvents(this.#db, {
      after_cursor: cursor,
      ...(taskId ? { task_id: taskId } : {}),
    });
  }

  status(taskOrRunId: string): { task: Task; runs: RunRecord[] } | undefined {
    const run = getRun(this.#db, taskOrRunId);
    const task = getTask(this.#db, run?.task_id ?? taskOrRunId);
    if (!task) return undefined;
    return { task, runs: listRuns(this.#db, { task_id: task.id, limit: 20 }) };
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

  /** An artifact and, for files inside the artifact root, its text. */
  getArtifact(id: string): { artifact: Artifact; content?: string } | undefined {
    const artifact = getArtifact(this.#db, id);
    if (!artifact) return undefined;
    const root = resolve(this.#artifactsRoot);
    const path = resolve(artifact.path_or_url);
    let content: string | undefined;
    if (artifact.kind !== "url" && path.startsWith(`${root}/`) && existsSync(path)) {
      try {
        content = readFileSync(path, "utf8");
      } catch {
        content = undefined;
      }
    }
    return { artifact, ...(content !== undefined ? { content } : {}) };
  }

  #requireTask(id: string): Task {
    const task = getTask(this.#db, id);
    if (!task) throw new ActionCenterError(`task ${id} not found`, "not_found", 404);
    return task;
  }
}

export {
  createChildProcessWorkerExecutor,
  sanitizeWorkerEnv,
  type ChildWorkerOptions,
} from "./child-worker.js";
