/**
 * Delegated tasks end to end (PROPOSAL D1, D3, D9): submission returns at once,
 * the run happens in the background under a lease, a question parks the task in
 * the Inbox, answering it there resumes the task, and Stop, timeouts, budgets
 * and restarts all end in an honest state.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { repoRoot, type Config } from "../src/config/index.js";
import { getActionItem, listActionItems, listAuditTrail } from "../src/store/action-items.js";
import { admitRun, fenceRun, getRun, listRuns, reconcileInterruptedRunsAndTasks } from "../src/store/runs.js";
import { createTask, getTask, listActivityEvents } from "../src/store/tasks.js";
import { createChildProcessExecutor } from "../src/worker/child-executor.js";
import {
  WorkerService,
  resolveTaskArtifactPath,
  type WorkerExecutor,
  type WorkerRunContext,
} from "../src/worker/index.js";

const CAPABILITIES = join(repoRoot(), "capabilities");

const WORKER_CONFIG: Config["worker"] = {
  account: "test-no-such-key",
  model: "claude-opus-5-5",
  max_turns: 5,
  run_budget_usd: 1,
  monthly_budget_usd: 10,
  timeout_ms: 60_000,
  concurrency: 1,
};

let tmpDir: string;
const apps: App[] = [];

function makeApp(executor?: WorkerExecutor): App {
  const app = createApp({
    dbPath: ":memory:",
    capabilitiesDir: CAPABILITIES,
    artifactsRoot: join(tmpDir, "artifacts"),
    ...(executor ? { workerExecutor: executor } : {}),
  });
  apps.push(app);
  return app;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "samaritan-worker-"));
});

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.worker.whenIdle();
    app.close();
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Asks on its first run; on the next, writes a brief and proposes a task. */
function askThenFinish(seen: WorkerRunContext[]): WorkerExecutor {
  return async (tools, context) => {
    seen.push(context);
    if (context.answers.length === 0) {
      tools.recordSession("session-1");
      await tools.askQuestion("Include archived 2025 contracts?", "Scope check");
      return { status: "succeeded", summary: "Waiting for an answer", cost_usd: 0.02 };
    }
    tools.writeArtifact({ filename: "report.md", content: `Scope: ${context.answers.at(-1)}\n` });
    await tools.proposeAction({ kind: "task", title: "Review vendor clauses" });
    return { status: "succeeded", summary: "Report written", cost_usd: 0.05 };
  };
}

describe("submission", () => {
  it("returns a queued task at once and runs it in the background", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = makeApp(async () => {
      await gate;
      return { status: "succeeded", summary: "done" };
    });

    const { task, created } = app.worker.submit({ goal: "Summarise the week", origin: "ui" });
    expect(created).toBe(true);
    expect(task.status).toBe("queued");
    expect(task.origin).toBe("ui");

    await new Promise((r) => setTimeout(r, 20));
    expect(getTask(app.db, task.id)?.status).toBe("running");
    release();
    await app.worker.whenIdle();
    expect(getTask(app.db, task.id)?.status).toBe("succeeded");
  });

  it("treats a repeated request key as the same task", async () => {
    const app = makeApp(async () => ({ status: "succeeded", summary: "ok" }));
    const first = app.worker.submit({ goal: "One", request_key: "mcp:abc" });
    const again = app.worker.submit({ goal: "One", request_key: "mcp:abc" });
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(first.task.id);
    await app.worker.whenIdle();
    expect(listRuns(app.db, { task_id: first.task.id })).toHaveLength(1);
  });
});

describe("questions", () => {
  it("parks on a question, resumes on an answer with the session, and ends awaiting review", async () => {
    const seen: WorkerRunContext[] = [];
    const app = makeApp(askThenFinish(seen));
    const { task } = app.worker.submit({ goal: "Audit vendor renewals", lane: "operations" });
    await app.worker.whenIdle();

    expect(getTask(app.db, task.id)?.status).toBe("needs_input");
    const [question] = listActionItems(app.db, { task_id: task.id, type: "task-question" });
    expect(question?.status).toBe("pending");

    await app.worker.answer(task.id, "Only active 2026 contracts", { actor: "sandip" });
    await app.worker.whenIdle();

    // The answer went through respond() and the execution registry, so it has
    // an audit trail like any other decision.
    const answered = getActionItem(app.db, question!.id)!;
    expect(answered.status).toBe("executed");
    expect(answered.custom["answer"]).toBe("Only active 2026 contracts");
    expect(listAuditTrail(app.db, question!.id).map((e) => e.actor)).toContain("sandip");

    expect(seen[1]).toEqual({ answers: ["Only active 2026 contracts"], resume_session_id: "session-1" });
    const done = getTask(app.db, task.id)!;
    expect(done.status).toBe("awaiting_review");
    expect(done.revision).toBe(2);
    const path = resolveTaskArtifactPath(join(tmpDir, "artifacts"), task.id, "report.md");
    expect(readFileSync(path, "utf8")).toContain("Only active 2026 contracts");
    expect(app.worker.monthSpendUsd()).toBeCloseTo(0.07);
  });

  it("resumes when the question is answered from the Inbox itself", async () => {
    const app = makeApp(askThenFinish([]));
    const { task } = app.worker.submit({ goal: "Plan the offsite" });
    await app.worker.whenIdle();
    const [question] = listActionItems(app.db, { task_id: task.id, type: "task-question" });

    await app.actionCenter.respond(question!.id, {
      response_id: "answer",
      edited_payload: { ...question!.custom, answer: "Bangalore, two days" },
      expected_revision: question!.revision,
      require_binding: true,
    });
    await app.worker.whenIdle();
    expect(getTask(app.db, task.id)?.status).toBe("awaiting_review");
  });

  it("refuses to treat a proposal as a question, so answering can never approve", async () => {
    const app = makeApp(askThenFinish([]));
    const { task } = app.worker.submit({ goal: "Audit" });
    await app.worker.whenIdle();
    await app.worker.answer(task.id, "yes", { actor: "assistant" });
    await app.worker.whenIdle();

    const [proposal] = listActionItems(app.db, { task_id: task.id, type: "task-action-proposal" });
    expect(proposal?.status).toBe("pending");
    await expect(app.worker.answer(proposal!.id, "approve it", { actor: "assistant" })).rejects.toThrow(
      /no task or clarifying question/,
    );
    expect(getActionItem(app.db, proposal!.id)?.status).toBe("pending");
  });

  it("does not revive a stopped task, and Stop clears its open question", async () => {
    const app = makeApp(askThenFinish([]));
    const { task } = app.worker.submit({ goal: "Audit" });
    await app.worker.whenIdle();
    const [question] = listActionItems(app.db, { task_id: task.id, type: "task-question" });

    await app.worker.cancel(task.id);
    expect(getActionItem(app.db, question!.id)?.status).toBe("rejected");
    await expect(app.worker.answer(task.id, "too late", { actor: "sandip" })).rejects.toThrow(
      /no open question/,
    );
    expect(getTask(app.db, task.id)?.status).toBe("cancelled");
  });
});

describe("answers bind to the question they answer", () => {
  it("refuses a late reply to a question that was already replaced", async () => {
    const app = makeApp(async (tools, context) => {
      if (context.answers.length < 2) {
        await tools.askQuestion(context.answers.length === 0 ? "Which quarter?" : "Which region?");
      }
      return { status: "succeeded", summary: "ok" };
    });
    const { task } = app.worker.submit({ goal: "Report" });
    await app.worker.whenIdle();
    const [q1] = listActionItems(app.db, { task_id: task.id, type: "task-question" });
    await app.worker.answer(q1!.id, "Q3", { actor: "sandip" });
    await app.worker.whenIdle();

    // Q2 is open now. A reply aimed at Q1 must not land on it.
    await expect(app.worker.answer(q1!.id, "late reply to Q1", { actor: "sandip" })).rejects.toThrow(
      /already answered or replaced/,
    );
    const q2 = listActionItems(app.db, { task_id: task.id, type: "task-question", status: ["pending"] })[0];
    expect(q2?.custom["question"]).toBe("Which region?");
    expect(q2?.custom["answer"]).toBe("");
  });

  it("lets an assistant answer only the tasks an assistant submitted", async () => {
    const app = makeApp(askThenFinish([]));
    const { task } = app.worker.submit({ goal: "Sandip's own task", origin: "telegram" });
    await app.worker.whenIdle();
    await expect(
      app.worker.answer(task.id, "sure", { actor: "assistant", onlyOrigin: "mcp" }),
    ).rejects.toThrow(/not submitted over mcp/);
    expect(getTask(app.db, task.id)?.status).toBe("needs_input");
  });
});

describe("stopping", () => {
  it("fences a cancelled run so its late writes are refused", async () => {
    let lateWrite: (() => void) | undefined;
    const app = makeApp(
      (tools, _context, signal) =>
        new Promise((_resolve, reject) => {
          lateWrite = () => tools.writeArtifact({ filename: "late.md", content: "x" });
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { task } = app.worker.submit({ goal: "Long research" });
    await new Promise((r) => setTimeout(r, 20));
    const [run] = listRuns(app.db, { task_id: task.id });
    expect(run?.status).toBe("running");

    await app.worker.cancel(task.id);
    await app.worker.whenIdle();
    expect(getRun(app.db, run!.id)?.status).toBe("cancelled");
    expect(getTask(app.db, task.id)?.status).toBe("cancelled");
    expect(() => lateWrite!()).toThrow(/lease is no longer active/);
    expect(existsSync(join(tmpDir, "artifacts", task.id, "late.md"))).toBe(false);
  });

  it("fails a run that outlives its timeout", async () => {
    const app = createApp({ dbPath: ":memory:", capabilitiesDir: CAPABILITIES });
    apps.push(app);
    const worker = new WorkerService({
      db: app.db,
      actionCenter: app.actionCenter,
      artifactsRoot: join(tmpDir, "artifacts"),
      config: { ...WORKER_CONFIG, timeout_ms: 30 },
      executor: (_tools, _context, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")))),
    });
    const { task } = worker.submit({ goal: "Never ends" });
    await new Promise((r) => setTimeout(r, 100));
    await worker.whenIdle();
    expect(getTask(app.db, task.id)?.status).toBe("failed");
    expect(listRuns(app.db, { task_id: task.id })[0]?.status).toBe("timeout");
  });
});

describe("guards", () => {
  it("fails without running once the monthly budget is spent", async () => {
    const app = createApp({ dbPath: ":memory:", capabilitiesDir: CAPABILITIES });
    apps.push(app);
    let ran = false;
    const worker = new WorkerService({
      db: app.db,
      actionCenter: app.actionCenter,
      artifactsRoot: join(tmpDir, "artifacts"),
      config: { ...WORKER_CONFIG, monthly_budget_usd: 0.05 },
      executor: async () => {
        ran = true;
        return { status: "succeeded", summary: "ok", cost_usd: 0.06 };
      },
    });
    worker.submit({ goal: "First" });
    await worker.whenIdle();
    const { task } = worker.submit({ goal: "Second" });
    ran = false;
    await worker.whenIdle();
    expect(ran).toBe(false);
    expect(getTask(app.db, task.id)?.result_summary).toMatch(/Monthly worker budget reached/);
  });

  it("explains how to add the API key instead of running without one", async () => {
    const app = createApp({ dbPath: ":memory:", capabilitiesDir: CAPABILITIES });
    apps.push(app);
    const worker = new WorkerService({
      db: app.db,
      actionCenter: app.actionCenter,
      artifactsRoot: join(tmpDir, "artifacts"),
      config: WORKER_CONFIG,
    });
    const { task } = worker.submit({ goal: "Anything" });
    await worker.whenIdle();
    const failed = getTask(app.db, task.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.result_summary).toMatch(/anthropic:test-no-such-key/);
    expect(listRuns(app.db, { task_id: task.id })).toHaveLength(0);
  });
});

describe("restart", () => {
  it("marks a running task interrupted and leaves a queued one to start", async () => {
    const app = makeApp(async () => ({ status: "succeeded", summary: "ran after boot" }));
    app.worker.stop(); // nothing dispatches while the "crash" state is set up
    const running = createTask(app.db, { goal: "Was running", status: "running" });
    admitRun(app.db, { task_id: running.id, runner: "child-process" });
    const queued = createTask(app.db, { goal: "Never started" });

    const reconciled = reconcileInterruptedRunsAndTasks(app.db);
    expect(reconciled).toEqual({ runs: 1, tasks: 1 });
    expect(getTask(app.db, running.id)?.status).toBe("interrupted");
    expect(getTask(app.db, queued.id)?.status).toBe("queued");
    expect(
      listActivityEvents(app.db, { task_id: running.id }).some((e) => e.type === "run.interrupted"),
    ).toBe(true);

    const fresh = new WorkerService({
      db: app.db,
      actionCenter: app.actionCenter,
      artifactsRoot: join(tmpDir, "artifacts"),
      config: WORKER_CONFIG,
      executor: async () => ({ status: "succeeded", summary: "ran after boot" }),
    });
    fresh.resumeQueued();
    await fresh.whenIdle();
    expect(getTask(app.db, queued.id)?.status).toBe("succeeded");

    // An interrupted task runs again only when Sandip retries it.
    fresh.start(running.id);
    await fresh.whenIdle();
    expect(getTask(app.db, running.id)).toMatchObject({ status: "succeeded", revision: 2 });
  });
});

describe("child process executor", () => {
  const entry = join(repoRoot(), "test", "fixtures", "worker-child.ts");

  it("proxies the child's tool calls through the lease-checked tools", async () => {
    const app = makeApp(createChildProcessExecutor({
      apiKey: "test",
      model: "m",
      maxTurns: 1,
      runBudgetUsd: 1,
      entry,
    }));
    const { task } = app.worker.submit({ goal: "write" });
    await app.worker.whenIdle();

    const done = getTask(app.db, task.id)!;
    expect(done.status).toBe("succeeded");
    expect(readFileSync(join(tmpDir, "artifacts", task.id, "out.md"), "utf8")).toBe("# from the child\n");
    const [run] = listRuns(app.db, { task_id: task.id });
    expect(run).toMatchObject({ runner: "worker", remote_run_id: "fixture-session", cost_usd: 0.01 });
  }, 20_000);

  it("ends the run, rather than crashing the daemon, when its lease is fenced from outside", async () => {
    const app = makeApp(createChildProcessExecutor({
      apiKey: "test",
      model: "m",
      maxTurns: 1,
      runBudgetUsd: 1,
      entry,
      killGraceMs: 200,
    }));
    const { task } = app.worker.submit({ goal: "hang" });
    for (let i = 0; i < 200; i++) {
      if (listActivityEvents(app.db, { task_id: task.id }).some((e) => e.type === "run.progress")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // What a second daemon's boot reconciliation would do: fence, without aborting.
    const [run] = listRuns(app.db, { task_id: task.id });
    fenceRun(app.db, run!.id, "interrupted", "fenced elsewhere");
    await app.worker.whenIdle();
    expect(getTask(app.db, task.id)?.status).not.toBe("running");
  }, 20_000);

  it("kills the child on Stop and records that it exited", async () => {
    const app = makeApp(createChildProcessExecutor({
      apiKey: "test",
      model: "m",
      maxTurns: 1,
      runBudgetUsd: 1,
      entry,
      killGraceMs: 200,
    }));
    const { task } = app.worker.submit({ goal: "hang" });
    for (let i = 0; i < 200; i++) {
      if (listActivityEvents(app.db, { task_id: task.id }).some((e) => e.type === "run.progress")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await app.worker.cancel(task.id);
    await app.worker.whenIdle();

    expect(getTask(app.db, task.id)?.status).toBe("cancelled");
    const exited = listActivityEvents(app.db, { task_id: task.id }).find((e) => e.type === "run.exited");
    expect(exited?.payload["verified"]).toBe(true);
  }, 20_000);
});
