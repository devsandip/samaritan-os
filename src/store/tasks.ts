/**
 * Store persistence for delegated Tasks, Artifacts, and Activity Events (PROPOSAL D1, D3).
 */
import { randomUUID } from "node:crypto";
import type { Db, SqlValue } from "./db.js";
import {
  ActivityEvent,
  type ActivityEventType,
  Artifact,
  type ArtifactKind,
  Task,
  type TaskLane,
  type TaskStatus,
  nowIso,
} from "../types/index.js";

export interface CreateTaskInput {
  id?: string;
  goal: string;
  lane?: TaskLane;
  scope?: "work" | "personal";
  status?: TaskStatus;
  runner?: string;
  parent_task_id?: string | null;
}

export interface UpdateTaskPatch {
  status?: TaskStatus;
  revision?: number;
  bumpRevision?: boolean;
  result_summary?: string | null;
}

export interface ListTasksFilter {
  status?: TaskStatus | TaskStatus[];
  lane?: TaskLane;
  scope?: "work" | "personal";
  limit?: number;
  offset?: number;
}

interface TaskRow {
  id: string;
  goal: string;
  lane: string;
  scope?: string;
  status: string;
  revision: number;
  runner: string;
  parent_task_id: string | null;
  result_summary: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return Task.parse({
    id: row.id,
    goal: row.goal,
    lane: row.lane,
    scope: row.scope ?? "work",
    status: row.status,
    revision: row.revision,
    runner: row.runner,
    parent_task_id: row.parent_task_id,
    result_summary: row.result_summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

export function getTask(db: Db, id: string): Task | undefined {
  const row = db.prepare<TaskRow>("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? rowToTask(row) : undefined;
}

export function listTasks(db: Db, filter: ListTasksFilter = {}): Task[] {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  const statuses = filter.status
    ? Array.isArray(filter.status)
      ? filter.status
      : [filter.status]
    : [];
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (filter.lane) {
    clauses.push("lane = ?");
    params.push(filter.lane);
  }
  if (filter.scope) {
    clauses.push("scope = ?");
    params.push(filter.scope);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  params.push(filter.limit ?? 50, filter.offset ?? 0);

  return db
    .prepare<TaskRow>(`SELECT * FROM tasks${where} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .all(...params)
    .map(rowToTask);
}

export function createTask(db: Db, input: CreateTaskInput): Task {
  const now = nowIso();
  const task = Task.parse({
    id: input.id ?? randomUUID(),
    goal: input.goal,
    lane: input.lane ?? "general",
    scope: input.scope ?? "work",
    status: input.status ?? "queued",
    revision: 1,
    runner: input.runner ?? "worker",
    parent_task_id: input.parent_task_id ?? null,
    result_summary: null,
    created_at: now,
    updated_at: now,
  });

  return db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks
         (id, goal, lane, scope, status, revision, runner, parent_task_id, result_summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.id,
      task.goal,
      task.lane,
      task.scope,
      task.status,
      task.revision,
      task.runner,
      task.parent_task_id,
      task.result_summary,
      task.created_at,
      task.updated_at,
    );

    appendActivityEvent(db, {
      task_id: task.id,
      type: "task.submitted",
      payload: { goal: task.goal, lane: task.lane, runner: task.runner },
      created_at: now,
    });

    return task;
  });
}

export function updateTask(db: Db, id: string, patch: UpdateTaskPatch): Task {
  return db.transaction(() => {
    const existing = getTask(db, id);
    if (!existing) throw new Error(`task ${id} not found`);

    const nextRevision =
      patch.revision !== undefined
        ? patch.revision
        : patch.bumpRevision
          ? existing.revision + 1
          : existing.revision;

    const updated = Task.parse({
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.result_summary !== undefined ? { result_summary: patch.result_summary } : {}),
      revision: nextRevision,
      updated_at: nowIso(),
    });

    db.prepare(
      `UPDATE tasks
          SET status = ?, revision = ?, result_summary = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      updated.status,
      updated.revision,
      updated.result_summary,
      updated.updated_at,
      updated.id,
    );

    return updated;
  });
}

// ---- Artifacts --------------------------------------------------------------

export interface CreateArtifactInput {
  id?: string;
  task_id?: string | null;
  run_id?: string | null;
  kind: ArtifactKind;
  path_or_url: string;
  content_hash: string;
  media_type?: string;
}

interface ArtifactRow {
  id: string;
  task_id: string | null;
  run_id: string | null;
  kind: string;
  path_or_url: string;
  content_hash: string;
  media_type: string;
  created_at: string;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return Artifact.parse({
    id: row.id,
    task_id: row.task_id,
    run_id: row.run_id,
    kind: row.kind,
    path_or_url: row.path_or_url,
    content_hash: row.content_hash,
    media_type: row.media_type,
    created_at: row.created_at,
  });
}

export function registerArtifact(db: Db, input: CreateArtifactInput): Artifact {
  const now = nowIso();
  const artifact = Artifact.parse({
    id: input.id ?? randomUUID(),
    task_id: input.task_id ?? null,
    run_id: input.run_id ?? null,
    kind: input.kind,
    path_or_url: input.path_or_url,
    content_hash: input.content_hash,
    media_type: input.media_type ?? "text/markdown",
    created_at: now,
  });

  return db.transaction(() => {
    db.prepare(
      `INSERT INTO artifacts
         (id, task_id, run_id, kind, path_or_url, content_hash, media_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      artifact.id,
      artifact.task_id,
      artifact.run_id,
      artifact.kind,
      artifact.path_or_url,
      artifact.content_hash,
      artifact.media_type,
      artifact.created_at,
    );

    appendActivityEvent(db, {
      task_id: artifact.task_id,
      run_id: artifact.run_id,
      type: "artifact.created",
      payload: {
        artifact_id: artifact.id,
        kind: artifact.kind,
        path_or_url: artifact.path_or_url,
        content_hash: artifact.content_hash,
        media_type: artifact.media_type,
      },
      created_at: now,
    });

    return artifact;
  });
}

export function getArtifact(db: Db, id: string): Artifact | undefined {
  const row = db.prepare<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?").get(id);
  return row ? rowToArtifact(row) : undefined;
}

export function listArtifacts(
  db: Db,
  filter: { task_id?: string; run_id?: string; limit?: number } = {},
): Artifact[] {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (filter.task_id) {
    clauses.push("task_id = ?");
    params.push(filter.task_id);
  }
  if (filter.run_id) {
    clauses.push("run_id = ?");
    params.push(filter.run_id);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  params.push(filter.limit ?? 100);
  return db
    .prepare<ArtifactRow>(`SELECT * FROM artifacts${where} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
    .all(...params)
    .map(rowToArtifact);
}

// ---- Activity Events --------------------------------------------------------

export interface AppendActivityEventInput {
  id?: string;
  task_id?: string | null;
  run_id?: string | null;
  capability_id?: string | null;
  type: ActivityEventType;
  payload: Record<string, unknown>;
  created_at?: string;
}

interface ActivityEventRow {
  cursor: number;
  id: string;
  task_id: string | null;
  run_id: string | null;
  capability_id: string | null;
  type: string;
  payload_json: string;
  created_at: string;
}

function rowToActivityEvent(row: ActivityEventRow): ActivityEvent {
  return ActivityEvent.parse({
    cursor: Number(row.cursor),
    id: row.id,
    task_id: row.task_id,
    run_id: row.run_id,
    capability_id: row.capability_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    created_at: row.created_at,
  });
}

export function appendActivityEvent(db: Db, input: AppendActivityEventInput): ActivityEvent {
  const id = input.id ?? randomUUID();
  const createdAt = input.created_at ?? nowIso();
  const res = db
    .prepare(
      `INSERT INTO activity_events
         (id, task_id, run_id, capability_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.task_id ?? null,
      input.run_id ?? null,
      input.capability_id ?? null,
      input.type,
      JSON.stringify(input.payload),
      createdAt,
    );

  return ActivityEvent.parse({
    cursor: Number(res.lastInsertRowid),
    id,
    task_id: input.task_id ?? null,
    run_id: input.run_id ?? null,
    capability_id: input.capability_id ?? null,
    type: input.type,
    payload: input.payload,
    created_at: createdAt,
  });
}

export interface ListActivityFilter {
  after_cursor?: number;
  task_id?: string;
  run_id?: string;
  capability_id?: string;
  type?: ActivityEventType;
  limit?: number;
}

export function listActivityEvents(db: Db, filter: ListActivityFilter = {}): ActivityEvent[] {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  if (filter.after_cursor !== undefined) {
    clauses.push("cursor > ?");
    params.push(filter.after_cursor);
  }
  if (filter.task_id) {
    clauses.push("task_id = ?");
    params.push(filter.task_id);
  }
  if (filter.run_id) {
    clauses.push("run_id = ?");
    params.push(filter.run_id);
  }
  if (filter.capability_id) {
    clauses.push("capability_id = ?");
    params.push(filter.capability_id);
  }
  if (filter.type) {
    clauses.push("type = ?");
    params.push(filter.type);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const order = filter.after_cursor !== undefined ? "ASC" : "DESC";
  params.push(filter.limit ?? 100);

  return db
    .prepare<ActivityEventRow>(`SELECT * FROM activity_events${where} ORDER BY cursor ${order} LIMIT ?`)
    .all(...params)
    .map(rowToActivityEvent);
}
