/**
 * Run admission, lease fencing, cancellation, and boot recovery (PROPOSAL D3, G2).
 *
 * Every capability run or delegated task run is admitted here before work begins.
 * Two properties are enforced at the store boundary:
 * 1. Admission deduplication: a unique `admission_key` prevents overlapping
 *    scheduler ticks, event redeliveries, or double-clicked manual runs from
 *    launching duplicate runs.
 * 2. Lease fencing: each active run holds a `lease_token` and `fencing_generation`.
 *    When a run times out, is cancelled, or is superseded on boot, its lease is
 *    revoked and `fencing_generation` is incremented so a zombie process or late
 *    in-process promise cannot emit action items or overwrite run state.
 */
import { randomUUID } from "node:crypto";
import type { Db, SqlValue } from "./db.js";
import {
  RunRecord,
  type RunRecordStatus,
  type RunRunner,
  nowIso,
} from "../types/index.js";
import { appendActivityEvent } from "./tasks.js";

export interface AdmitRunInput {
  id?: string;
  task_id?: string | null;
  capability_id?: string | null;
  runner: RunRunner;
  remote_run_id?: string | null;
  admission_key?: string | null;
  scheduled_for?: string | null;
  input_hash?: string | null;
  lease_ttl_ms?: number;
}

export interface AdmitRunResult {
  admitted: boolean;
  run: RunRecord;
}

interface RunRow {
  id: string;
  task_id: string | null;
  capability_id: string | null;
  runner: string;
  remote_run_id: string | null;
  admission_key: string | null;
  scheduled_for?: string | null;
  input_hash?: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  fencing_generation: number;
  status: string;
  cost_usd: number;
  started_at: string;
  heartbeat_at: string;
  ended_at: string | null;
  error: string | null;
}

function rowToRun(row: RunRow): RunRecord {
  return RunRecord.parse({
    id: row.id,
    task_id: row.task_id,
    capability_id: row.capability_id,
    runner: row.runner,
    remote_run_id: row.remote_run_id,
    admission_key: row.admission_key,
    scheduled_for: row.scheduled_for ?? null,
    input_hash: row.input_hash ?? null,
    lease_token: row.lease_token,
    lease_expires_at: row.lease_expires_at,
    fencing_generation: row.fencing_generation,
    status: row.status,
    cost_usd: row.cost_usd,
    started_at: row.started_at,
    heartbeat_at: row.heartbeat_at,
    ended_at: row.ended_at,
    error: row.error,
  });
}

export function getRun(db: Db, id: string): RunRecord | undefined {
  const row = db.prepare<RunRow>("SELECT * FROM runs WHERE id = ?").get(id);
  return row ? rowToRun(row) : undefined;
}

export function getRunByAdmissionKey(db: Db, admissionKey: string): RunRecord | undefined {
  const row = db
    .prepare<RunRow>("SELECT * FROM runs WHERE admission_key = ?")
    .get(admissionKey);
  return row ? rowToRun(row) : undefined;
}

export function listRuns(
  db: Db,
  filter: {
    task_id?: string;
    capability_id?: string;
    status?: RunRecordStatus | RunRecordStatus[];
    limit?: number;
  } = {},
): RunRecord[] {
  const clauses: string[] = [];
  const params: SqlValue[] = [];

  if (filter.task_id) {
    clauses.push("task_id = ?");
    params.push(filter.task_id);
  }
  if (filter.capability_id) {
    clauses.push("capability_id = ?");
    params.push(filter.capability_id);
  }
  const statuses = filter.status
    ? Array.isArray(filter.status)
      ? filter.status
      : [filter.status]
    : [];
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  params.push(filter.limit ?? 100);

  return db
    .prepare<RunRow>(`SELECT * FROM runs${where} ORDER BY started_at DESC, rowid DESC LIMIT ?`)
    .all(...params)
    .map(rowToRun);
}

export function admitRun(db: Db, input: AdmitRunInput): AdmitRunResult {
  return db.transaction(() => {
    if (input.admission_key) {
      const existing = getRunByAdmissionKey(db, input.admission_key);
      if (existing) {
        return { admitted: false, run: existing };
      }
    }

    const now = new Date();
    const nowStr = now.toISOString();
    const leaseTtlMs = input.lease_ttl_ms ?? 5 * 60_000;
    const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs).toISOString();

    const run = RunRecord.parse({
      id: input.id ?? randomUUID(),
      task_id: input.task_id ?? null,
      capability_id: input.capability_id ?? null,
      runner: input.runner,
      remote_run_id: input.remote_run_id ?? null,
      admission_key: input.admission_key ?? null,
      scheduled_for: input.scheduled_for ?? null,
      input_hash: input.input_hash ?? null,
      lease_token: randomUUID(),
      lease_expires_at: leaseExpiresAt,
      fencing_generation: 1,
      status: "running",
      cost_usd: 0,
      started_at: nowStr,
      heartbeat_at: nowStr,
      ended_at: null,
      error: null,
    });

    db.prepare(
      `INSERT INTO runs
         (id, task_id, capability_id, runner, remote_run_id, admission_key,
          scheduled_for, input_hash, lease_token, lease_expires_at,
          fencing_generation, status, cost_usd, started_at, heartbeat_at, ended_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.task_id,
      run.capability_id,
      run.runner,
      run.remote_run_id,
      run.admission_key,
      run.scheduled_for,
      run.input_hash,
      run.lease_token,
      run.lease_expires_at,
      run.fencing_generation,
      run.status,
      run.cost_usd,
      run.started_at,
      run.heartbeat_at,
      run.ended_at,
      run.error,
    );

    appendActivityEvent(db, {
      task_id: run.task_id,
      run_id: run.id,
      capability_id: run.capability_id,
      type: "run.started",
      payload: {
        runner: run.runner,
        admission_key: run.admission_key,
        fencing_generation: run.fencing_generation,
      },
      created_at: nowStr,
    });

    return { admitted: true, run };
  });
}

export class StaleLeaseError extends Error {
  constructor(
    readonly runId: string,
    message = `run ${runId} lease is no longer active (fenced, timed out, or cancelled)`,
  ) {
    super(message);
    this.name = "StaleLeaseError";
  }
}

export function isLeaseValid(
  db: Db,
  runId: string,
  leaseToken: string,
  expectedGeneration?: number,
): boolean {
  const run = getRun(db, runId);
  if (!run) return false;
  if (run.status !== "running") return false;
  if (!run.lease_token || run.lease_token !== leaseToken) return false;
  if (expectedGeneration !== undefined && run.fencing_generation !== expectedGeneration) {
    return false;
  }
  if (run.lease_expires_at && Date.parse(run.lease_expires_at) < Date.now()) {
    return false;
  }
  return true;
}

export function assertLeaseValid(
  db: Db,
  runId: string,
  leaseToken: string,
  expectedGeneration?: number,
): void {
  if (!isLeaseValid(db, runId, leaseToken, expectedGeneration)) {
    throw new StaleLeaseError(runId);
  }
}

export function heartbeatRun(
  db: Db,
  runId: string,
  leaseToken: string,
  leaseTtlMs = 5 * 60_000,
): boolean {
  const now = new Date();
  const nowStr = now.toISOString();
  const nextExpiry = new Date(now.getTime() + leaseTtlMs).toISOString();
  const res = db
    .prepare(
      `UPDATE runs
          SET heartbeat_at = ?, lease_expires_at = ?
        WHERE id = ? AND status = 'running' AND lease_token = ?`,
    )
    .run(nowStr, nextExpiry, runId, leaseToken);
  return res.changes === 1;
}

export function finishRun(
  db: Db,
  runId: string,
  leaseToken: string,
  outcome: {
    status: "succeeded" | "failed" | "skipped";
    error?: string;
    cost_usd?: number;
  },
): RunRecord {
  return db.transaction(() => {
    assertLeaseValid(db, runId, leaseToken);
    const endedAt = nowIso();
    db.prepare(
      `UPDATE runs
          SET status = ?, lease_token = NULL, lease_expires_at = NULL,
              ended_at = ?, error = ?, cost_usd = COALESCE(?, cost_usd)
        WHERE id = ? AND lease_token = ?`,
    ).run(
      outcome.status,
      endedAt,
      outcome.error ?? null,
      outcome.cost_usd ?? null,
      runId,
      leaseToken,
    );

    const updated = getRun(db, runId)!;
    appendActivityEvent(db, {
      task_id: updated.task_id,
      run_id: updated.id,
      capability_id: updated.capability_id,
      type: outcome.status === "succeeded" ? "run.completed" : "run.failed",
      payload: {
        status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
        cost_usd: updated.cost_usd,
      },
      created_at: endedAt,
    });
    return updated;
  });
}

/**
 * Revokes a run's lease and bumps `fencing_generation` so any in-flight code
 * still holding the old `lease_token` is locked out from emitting items or
 * overwriting the run status.
 */
export function fenceRun(
  db: Db,
  runId: string,
  status: "cancelled" | "timeout" | "interrupted",
  reason?: string,
): RunRecord | undefined {
  return db.transaction(() => {
    const existing = getRun(db, runId);
    if (!existing) return undefined;
    if (existing.status !== "running") return existing;

    const endedAt = nowIso();
    const nextGen = existing.fencing_generation + 1;
    db.prepare(
      `UPDATE runs
          SET status = ?, lease_token = NULL, lease_expires_at = NULL,
              fencing_generation = ?, ended_at = ?, error = ?
        WHERE id = ?`,
    ).run(status, nextGen, endedAt, reason ?? status, runId);

    const updated = getRun(db, runId)!;
    const eventType =
      status === "cancelled"
        ? "run.cancelled"
        : status === "interrupted"
          ? "run.interrupted"
          : "run.failed";

    appendActivityEvent(db, {
      task_id: updated.task_id,
      run_id: updated.id,
      capability_id: updated.capability_id,
      type: eventType,
      payload: {
        status,
        reason: reason ?? status,
        fencing_generation: nextGen,
      },
      created_at: endedAt,
    });

    return updated;
  });
}

/**
 * Boot reconciliation for `runs` and `tasks` (PROPOSAL G2).
 *
 * A run still marked `running` belongs to a process that no longer exists: it
 * is fenced and marked `interrupted`, and so is a task that was running it.
 * That is the honest outcome. Re-running it silently could repeat whatever it
 * already did, so a retry is Sandip's call. A `queued` task never started, so
 * it is left queued and the worker picks it up after boot.
 */
export function reconcileInterruptedRunsAndTasks(db: Db): { runs: number; tasks: number } {
  return db.transaction(() => {
    const stuckRuns = listRuns(db, { status: "running", limit: 500 });
    for (const run of stuckRuns) {
      fenceRun(db, run.id, "interrupted", "daemon restarted while run was in progress");
    }

    const now = nowIso();
    const interrupted = db
      .prepare<{ id: string }>("SELECT id FROM tasks WHERE status = 'running'")
      .all();
    db.prepare(
      `UPDATE tasks
          SET status = 'interrupted',
              result_summary = 'Interrupted by a daemon restart; retry to run it again',
              updated_at = ?
        WHERE status = 'running'`,
    ).run(now);
    for (const { id } of interrupted) {
      appendActivityEvent(db, {
        task_id: id,
        type: "run.interrupted",
        payload: { reason: "daemon restarted while the task was running" },
        created_at: now,
      });
    }

    return { runs: stuckRuns.length, tasks: interrupted.length };
  });
}
