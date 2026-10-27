/**
 * The IPC contract between the daemon and a worker child process (PROPOSAL D1, D9).
 *
 * The child holds a model credential and reads untrusted text, so it holds
 * nothing else: no database handle, no adapter, no send or write credential.
 * Every effect it wants is a `tool_call` the parent performs on its behalf,
 * after checking that the run's lease is still live. Killing the child is what
 * cancellation means; the lease is what stops a late reply from counting.
 *
 * Messages travel over Node's `fork()` channel with JSON serialization, so
 * every field here must survive `JSON.stringify`.
 */

export type WorkerToolName = "search" | "write_artifact" | "ask_question" | "propose_action";

export interface StartMessage {
  type: "start";
  task: { id: string; goal: string; lane: string; revision: number };
  /** Answers to earlier clarifying questions, oldest first. */
  answers: string[];
  /** The SDK session to continue, set when the task resumes after an answer. */
  resume_session_id?: string;
  config: {
    model: string;
    max_turns: number;
    max_budget_usd: number;
    /** The task's artifact directory. The agent's only working directory. */
    cwd: string;
  };
}

export interface ToolResultMessage {
  type: "tool_result";
  id: string;
  ok: boolean;
  /** Text returned to the model when `ok`. */
  value?: string;
  error?: string;
}

export type ParentMessage = StartMessage | ToolResultMessage;

export interface ToolCallMessage {
  type: "tool_call";
  id: string;
  name: WorkerToolName;
  args: Record<string, unknown>;
}

export interface SessionMessage {
  type: "session";
  session_id: string;
}

export interface ProgressMessage {
  type: "progress";
  text: string;
}

export interface DoneMessage {
  type: "done";
  status: "succeeded" | "failed";
  summary: string;
  cost_usd: number;
  session_id?: string;
}

export type ChildMessage = ToolCallMessage | SessionMessage | ProgressMessage | DoneMessage;
