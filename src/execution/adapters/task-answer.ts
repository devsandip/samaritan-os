/**
 * `samaritan.task.answer`: what approving a worker's question does (PROPOSAL D2, D3).
 *
 * A delegated task's clarifying question is an ordinary Inbox item, so it is
 * answered the way anything else is decided: through `respond()`, with its audit
 * row and revision check. This adapter is the execution half. It hands the
 * answer to the worker, which re-queues the task at a new revision.
 *
 * The worker is resolved late because the execution registry is built before
 * the worker exists. The worker's resume is check-or-create on the item id, so
 * a replayed attempt is a no-op rather than a second resume.
 */
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from "../../types/index.js";

export interface TaskAnswerTarget {
  resumeWithAnswer(input: { task_id: string; answer: string; action_item_id: string }): {
    id: string;
    revision: number;
  };
}

export function createTaskAnswerAdapter(worker: () => TaskAnswerTarget | undefined): ExecutionAdapter {
  return {
    id: "samaritan.task.answer",
    provider: "samaritan",
    description: "Sends Sandip's answer to a delegated task and resumes it",
    modes: ["automated"],

    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      const taskId = request.payload["task_id"];
      const answer = request.payload["answer"];
      if (typeof taskId !== "string" || !taskId) {
        return { status: "failed", error: "the question carries no task_id" };
      }
      if (typeof answer !== "string" || !answer.trim()) {
        return { status: "failed", error: "an answer is required; edit the item and fill it in" };
      }
      const target = worker();
      if (!target) return { status: "failed", error: "the worker is not running" };
      try {
        const task = target.resumeWithAnswer({
          task_id: taskId,
          answer: answer.trim(),
          action_item_id: request.action_item_id,
        });
        return { status: "succeeded", result: { task_id: task.id, revision: task.revision } };
      } catch (err) {
        return { status: "failed", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
