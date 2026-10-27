import type { RunContext, RunResult } from "../../src/run-layer/context.js";

/**
 * Delegated Worker Task capability entrypoint.
 *
 * Questions and action proposals are normally emitted by `WorkerService` during
 * a background task run, but this entrypoint also accepts direct manual inputs
 * so `samaritan run-capability worker-task` works uniformly.
 */
export async function run(context: RunContext): Promise<RunResult> {
  const payload = (context.trigger.payload ?? {}) as Record<string, unknown>;
  const question = (context.inputs["question"] ?? payload["question"]) as string | undefined;
  const taskId = (context.inputs["task_id"] ?? payload["task_id"] ?? "manual-task") as string;
  const runId = (context.inputs["run_id"] ?? payload["run_id"] ?? "manual-run") as string;
  const lane = (context.inputs["lane"] ?? payload["lane"] ?? "general") as string;

  if (!question) {
    return {
      action_items: [],
      status: "ok",
      logs: ["no question supplied; worker-task idle"],
    };
  }

  return {
    action_items: [
      {
        capability_id: "worker-task",
        type: "task-question",
        task_id: taskId,
        run_id: runId,
        context: {
          what_happened: `Delegated task ${taskId} paused with a clarifying question`,
          source: { kind: "worker", id: taskId },
          provenance: ["worker-task.run"],
          why_flagged: "worker needs clarification before proceeding",
          trigger_reason: "policy",
          confidence: 0.9,
          decision_needed: question,
          decision_surface: "inbox",
          execution_surface: "samaritan",
          outcome_preview: `Resumes task ${taskId} with your answer`,
        },
        custom: {
          task_id: taskId,
          run_id: runId,
          lane,
          question,
          context_summary: String(context.inputs["context_summary"] ?? ""),
          answer: "",
        },
        dedupe_key: `worker-question:${taskId}:${runId}`,
      },
    ],
    status: "ok",
    logs: [`emitted question for task ${taskId}`],
  };
}
