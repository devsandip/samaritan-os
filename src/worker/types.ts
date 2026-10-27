/**
 * Worker contracts (PROPOSAL D1).
 *
 * Two seams, deliberately different sizes. `WorkerAdapter` is the five-method
 * surface the rest of Samaritan (API, MCP, Telegram, UI) uses to drive a
 * delegated task. `WorkerExecutor` is the one function a runtime implements:
 * given lease-checked tools, do the work and say how it ended. The Agent SDK
 * child process is one executor; Hermes or OpenClaw would be another, without
 * any change to the task ledger, the Inbox or the approvals around them.
 */
import type {
  ActivityEvent,
  Artifact,
  ArtifactKind,
  Actor,
  RunRecord,
  Task,
} from "../types/index.js";

export interface WorkerRunContext {
  /** Answers to the task's clarifying questions so far, oldest first. */
  answers: string[];
  /** The runtime session to continue after an answer, when it has one. */
  resume_session_id?: string;
}

export type ProposalKind = "decision" | "insight" | "task" | "person" | "note";

export interface WorkerProposal {
  kind: ProposalKind;
  title: string;
  detail?: string;
  project?: string;
  owner?: string;
  due?: string;
  evidence?: string;
}

/**
 * Everything a worker may do. Each call checks the run's lease first, so a
 * cancelled, timed-out or superseded run is refused even if its process is
 * still alive (PROPOSAL D9).
 */
export interface WorkerTools {
  readonly task: Task;
  readonly run: RunRecord;
  readonly artifactDir: string;
  recall(question: string): Promise<{
    answer: string;
    citations: { kind: string; ref: string; excerpt?: string }[];
  }>;
  recordToolCall(tool: string, args: Record<string, unknown>, summary?: string): void;
  recordProgress(text: string): void;
  recordSession(sessionId: string): void;
  isCancelled(): boolean;
  writeArtifact(input: {
    filename: string;
    content: string;
    kind?: ArtifactKind;
    media_type?: string;
  }): Artifact;
  askQuestion(question: string, contextSummary?: string): Promise<{ action_item_id: string }>;
  proposeAction(proposal: WorkerProposal): Promise<{ action_item_id: string }>;
}

export interface WorkerExecutionOutcome {
  /** How the runtime ended. Whether the task then waits on Sandip is derived from what it asked or proposed. */
  status: "succeeded" | "failed";
  summary: string;
  cost_usd?: number;
  session_id?: string;
}

export type WorkerExecutor = (
  tools: WorkerTools,
  context: WorkerRunContext,
  signal: AbortSignal,
) => Promise<WorkerExecutionOutcome>;

/** Thrown by an executor that stopped because its signal was aborted. */
export class WorkerAborted extends Error {
  constructor(
    reason: string,
    /** True when the executor saw its process exit, not just asked it to. */
    readonly terminated: boolean,
  ) {
    super(reason);
    this.name = "WorkerAborted";
  }
}

/** The five methods every Samaritan surface uses to drive a delegated task. */
export interface WorkerAdapter {
  start(taskId: string): Task;
  events(cursor?: number, taskId?: string): ActivityEvent[];
  answer(
    taskOrQuestionId: string,
    answer: string,
    options?: { actor?: Actor; expectedRevision?: number },
  ): Promise<Task>;
  cancel(taskOrRunId: string, reason?: string): Promise<Task | undefined>;
  status(taskOrRunId: string): { task: Task; runs: RunRecord[] } | undefined;
}
