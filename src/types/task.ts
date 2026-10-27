/**
 * Delegated Tasks, Runs, Artifacts, Activity Events, and Source Rules (PROPOSAL D1, D2, D3).
 */
import { z } from "zod";
import { IsoDateTime } from "./common.js";

export const DataScope = z.enum(["work", "personal"]);
export type DataScope = z.infer<typeof DataScope>;

export const TaskLane = z.enum(["general", "coding", "research", "operations"]);
export type TaskLane = z.infer<typeof TaskLane>;

export const TaskStatus = z.enum([
  "queued",
  "running",
  "needs_input",
  "awaiting_review",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  lane: TaskLane.default("general"),
  scope: DataScope.default("work"),
  status: TaskStatus,
  revision: z.number().int().min(1).default(1),
  runner: z.string().min(1).default("worker"),
  parent_task_id: z.string().nullable().default(null),
  result_summary: z.string().nullable().default(null),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type Task = z.infer<typeof Task>;

export const RunRunner = z.enum(["in-process", "child-process", "worker"]);
export type RunRunner = z.infer<typeof RunRunner>;

export const RunRecordStatus = z.enum([
  "running",
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
  "skipped",
]);
export type RunRecordStatus = z.infer<typeof RunRecordStatus>;

export const RunRecord = z.object({
  id: z.string().min(1),
  task_id: z.string().nullable().default(null),
  capability_id: z.string().nullable().default(null),
  runner: RunRunner,
  remote_run_id: z.string().nullable().default(null),
  admission_key: z.string().nullable().default(null),
  scheduled_for: IsoDateTime.nullable().default(null),
  input_hash: z.string().nullable().default(null),
  lease_token: z.string().nullable().default(null),
  lease_expires_at: IsoDateTime.nullable().default(null),
  fencing_generation: z.number().int().min(1).default(1),
  status: RunRecordStatus,
  cost_usd: z.number().min(0).default(0),
  started_at: IsoDateTime,
  heartbeat_at: IsoDateTime,
  ended_at: IsoDateTime.nullable().default(null),
  error: z.string().nullable().default(null),
});
export type RunRecord = z.infer<typeof RunRecord>;

export const ArtifactKind = z.enum(["file", "diff", "url", "transcript", "brief"]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const Artifact = z.object({
  id: z.string().min(1),
  task_id: z.string().nullable().default(null),
  run_id: z.string().nullable().default(null),
  kind: ArtifactKind,
  path_or_url: z.string().min(1),
  content_hash: z.string().min(1),
  media_type: z.string().min(1).default("text/markdown"),
  created_at: IsoDateTime,
});
export type Artifact = z.infer<typeof Artifact>;

export const ActivityEventType = z.enum([
  "task.submitted",
  "run.started",
  "tool.called",
  "artifact.created",
  "question.asked",
  "question.answered",
  "action.proposed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  "hook.received",
]);
export type ActivityEventType = z.infer<typeof ActivityEventType>;

export const ActivityEvent = z.object({
  cursor: z.number().int().min(1),
  id: z.string().min(1),
  task_id: z.string().nullable().default(null),
  run_id: z.string().nullable().default(null),
  capability_id: z.string().nullable().default(null),
  type: ActivityEventType,
  payload: z.record(z.string(), z.unknown()),
  created_at: IsoDateTime,
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const SourceRule = z.object({
  source_id: z.string().min(1),
  muted: z.boolean().default(false),
  snoozed_until: IsoDateTime.nullable().default(null),
  paused: z.boolean().default(false),
  updated_at: IsoDateTime,
});
export type SourceRule = z.infer<typeof SourceRule>;
