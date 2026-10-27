/**
 * Run Layer (TECH-SPEC §2.2, §5.2, §10).
 *
 * Loads a capability's entrypoint, calls `run(context)`, and ingests whatever
 * comes back. This is the piece that makes a capability folder executable
 * rather than declarative: before it, `entrypoint` was a field nothing read.
 *
 * Isolation is the whole job. A capability that throws, hangs, or returns
 * nonsense must not take the process with it, because the next capability in
 * the list is unrelated to it and so is the API server sharing the loop. Every
 * failure path here ends in a report, never a throw.
 *
 * Entrypoints are TypeScript and are imported directly: Node 24+ strips types
 * natively, so `capabilities/<id>/index.ts` runs with no build step in dev and
 * in production alike. Type stripping erases, it does not transform, so
 * capability code must avoid enums, namespaces and parameter properties, and
 * must write explicit extensions on relative imports.
 */
import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "../logger.js";
import type { CapabilityRegistry } from "../registry/index.js";
import type { Db } from "../store/db.js";
import {
  admitRun,
  assertLeaseValid,
  fenceRun,
  finishRun,
  getRun,
  StaleLeaseError,
} from "../store/runs.js";
import { isSourcePaused } from "../store/source-rules.js";
import { nowIso, type DraftActionItem, type RunRecord, type RunRunner } from "../types/index.js";
import {
  buildRunContext,
  type CapabilityEntrypoint,
  type Ingestor,
  type RecallAnswer,
  type RunResult,
  type RunTrigger,
} from "./context.js";
import {
  checkBillingAllowance,
  computeInputHash,
  hasUnchangedInputSucceeded,
} from "./billing.js";

const logger = log("run-layer");

export type RunStatus = "ok" | "error" | "timeout" | "skipped" | "cancelled";

export interface RunReport {
  run_id?: string;
  capability_id: string;
  status: RunStatus;
  /** Populated for every status except "ok". */
  error?: string;
  duration_ms: number;
  /** Ingest outcomes across both `ctx.emit()` and the returned `action_items`. */
  accepted: { id: string; dedupe_key: string; status: string }[];
  rejected: { errors: string[] }[];
  logs: string[];
  /** Declared in `manifest.context.inputs` but not supplied to this run. */
  missing_inputs: string[];
}

export interface RunLayerDeps {
  db: Db;
  capabilities: CapabilityRegistry;
  actionCenter: Ingestor;
}

export interface RunOptions {
  trigger?: Partial<RunTrigger>;
  inputs?: Record<string, unknown>;
  recall?: (question: string) => Promise<RecallAnswer>;
  /** Run even when the manifest says `enabled: false` or source_rules says paused. */
  force?: boolean;
  /** Unique admission key to deduplicate overlapping schedule/event/manual triggers. */
  admissionKey?: string;
  /** ISO timestamp when triggered by a schedule slot (PROPOSAL-v1 runs.scheduled_for). */
  scheduledFor?: string;
  /** Skip execution if the last succeeded run for this capability had identical inputs (PROPOSAL-v1 C2). */
  skipIfUnchanged?: boolean;
  /** Enforce monthly USD budget cap before admitting the run (PROPOSAL-v1 C2). */
  monthlyCapUsd?: number;
  /** Cost in USD incurred by this run, recorded on finishRun. */
  costUsd?: number;
  /** Optional parent task id when invoked on behalf of a delegated task. */
  taskId?: string;
  /** Execution isolation mode recorded on the `runs` row. */
  runner?: RunRunner;
}

interface ActiveRunControl {
  abort: (reason: string) => void;
  child?: ChildProcess;
}

const activeRuns = new Map<string, ActiveRunControl>();

/**
 * Registers a live child process or abort callback against a `runs.id` so
 * `cancelRun()` can kill the process and fence its lease immediately.
 */
export function registerActiveRun(runId: string, control: ActiveRunControl): void {
  activeRuns.set(runId, control);
}

export function unregisterActiveRun(runId: string): void {
  activeRuns.delete(runId);
}

/**
 * Cancels an active run (`POST /api/runs/:id/cancel`), killing any attached
 * child process (`SIGTERM` followed by `SIGKILL`) and fencing the run's lease
 * token in SQLite so late emissions are rejected (PROPOSAL G2).
 */
export function cancelRun(
  db: Db,
  runId: string,
  reason = "cancelled by user",
): RunRecord | undefined {
  const control = activeRuns.get(runId);
  const fenced = fenceRun(db, runId, "cancelled", reason);
  if (control) {
    if (control.child && !control.child.killed) {
      try {
        control.child.kill("SIGTERM");
        const childRef = control.child;
        const killTimer = setTimeout(() => {
          if (!childRef.killed) {
            try {
              childRef.kill("SIGKILL");
            } catch {
              // Process already exited.
            }
          }
        }, 1500);
        killTimer.unref();
      } catch {
        // Ignore kill race if process already exited.
      }
    }
    control.abort(reason);
    activeRuns.delete(runId);
  }
  return fenced ?? getRun(db, runId);
}

class RunFailure extends Error {
  constructor(
    message: string,
    readonly status: Exclude<RunStatus, "ok">,
  ) {
    super(message);
  }
}

/** Records the outcome on the `capabilities` row so the Dashboard can show it. */
function recordRun(db: Db, capabilityId: string, status: RunStatus): void {
  try {
    db.prepare("UPDATE capabilities SET last_run_at = ?, last_run_status = ? WHERE id = ?").run(
      nowIso(),
      status,
      capabilityId,
    );
  } catch (err) {
    // Telemetry is not worth failing a successful run over.
    logger.warn({ capabilityId, err: String(err) }, "could not record run telemetry");
  }
}

/**
 * Imports the entrypoint fresh enough to pick up an edit.
 *
 * Node caches ES modules by URL for the process lifetime, so without the mtime
 * query an author who edits a capability and hits reload keeps running the old
 * code — the exact loop the demo depends on. Distinct query strings are
 * distinct modules, which leaks the superseded one; at the rate a human edits
 * files that is irrelevant.
 */
async function loadEntrypoint(dir: string, entrypoint: string): Promise<CapabilityEntrypoint> {
  const path = join(dir, entrypoint);

  let mtime: number;
  try {
    // Truncated to an integer on purpose. `mtimeMs` is fractional, and a dot in
    // the query string reads as a file extension to the transform pipelines
    // that sit in front of `import()` under tsx and vitest — esbuild rejects
    // the fraction as a loader name. Whole milliseconds are more than enough to
    // notice a human editing a file.
    mtime = Math.trunc(statSync(path).mtimeMs);
  } catch {
    throw new RunFailure(
      `entrypoint "${entrypoint}" not found at ${path}. ` +
        `The manifest declares it; create it or run "samaritan new-capability" to scaffold one.`,
      "error",
    );
  }

  let module: Record<string, unknown>;
  try {
    module = (await import(`${pathToFileURL(path).href}?mtime=${mtime}`)) as Record<string, unknown>;
  } catch (err) {
    throw new RunFailure(`entrypoint failed to load: ${(err as Error).message}`, "error");
  }

  const run = module["run"];
  if (typeof run !== "function") {
    throw new RunFailure(
      `entrypoint ${entrypoint} does not export a "run" function (found: ${
        Object.keys(module).join(", ") || "nothing"
      })`,
      "error",
    );
  }
  return run as CapabilityEntrypoint;
}

/**
 * Races the run against the manifest's timeout.
 *
 * Note what this does and does not do: it stops *waiting*, it does not stop the
 * capability. A hung run keeps its timer or socket alive in the background.
 * §10's contract is that the OS stays responsive, which this delivers; killing
 * the work outright would need a worker thread, which is v1's problem.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, capabilityId: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RunFailure(`exceeded timeout_ms of ${ms}`, "timeout")),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runCapability(
  deps: RunLayerDeps,
  capabilityId: string,
  options: RunOptions = {},
): Promise<RunReport> {
  const started = Date.now();
  const base = { capability_id: capabilityId, accepted: [], rejected: [], logs: [] };
  const done = (report: Omit<RunReport, "duration_ms">): RunReport => ({
    ...report,
    duration_ms: Date.now() - started,
  });

  const loaded = deps.capabilities.get(capabilityId);
  if (!loaded) {
    // Not recorded: there is no capabilities row to record against.
    return done({
      ...base,
      status: "error",
      error: `unknown capability "${capabilityId}"`,
      missing_inputs: [],
    });
  }
  const { manifest, dir } = loaded;

  if (!manifest.enabled && !options.force) {
    return done({
      ...base,
      status: "skipped",
      error: `"${capabilityId}" is disabled in its manifest`,
      missing_inputs: [],
    });
  }

  if (!options.force && isSourcePaused(deps.db, capabilityId)) {
    return done({
      ...base,
      status: "skipped",
      error: `"${capabilityId}" is paused in source_rules`,
      missing_inputs: [],
    });
  }

  const inputHash = computeInputHash({
    inputs: options.inputs ?? {},
    payload: options.trigger?.payload ?? null,
  });

  const skipIfUnchanged = options.skipIfUnchanged ?? manifest.skip_if_unchanged ?? false;
  if (skipIfUnchanged && hasUnchangedInputSucceeded(deps.db, capabilityId, inputHash)) {
    return done({
      ...base,
      status: "skipped",
      error: `unchanged inputs (${inputHash.slice(0, 16)})`,
      missing_inputs: [],
    });
  }

  if (options.monthlyCapUsd !== undefined) {
    const allowance = checkBillingAllowance(deps.db, options.monthlyCapUsd);
    if (!allowance.allowed) {
      return done({
        ...base,
        status: "skipped",
        error: `budget_exceeded: monthly spend $${allowance.mtd_spend_usd.toFixed(2)} >= cap $${allowance.monthly_cap_usd.toFixed(2)}`,
        missing_inputs: [],
      });
    }
  }

  const { admitted, run: runRecord } = admitRun(deps.db, {
    capability_id: capabilityId,
    task_id: options.taskId ?? null,
    runner: options.runner ?? "in-process",
    admission_key: options.admissionKey ?? null,
    scheduled_for: options.scheduledFor ?? null,
    input_hash: inputHash,
    lease_ttl_ms: Math.max(manifest.timeout_ms + 30_000, 60_000),
  });

  if (!admitted) {
    logger.info(
      { capability: capabilityId, admissionKey: options.admissionKey, existingRunId: runRecord.id },
      "skipped duplicate run admission",
    );
    return done({
      ...base,
      run_id: runRecord.id,
      status: "skipped",
      error: `duplicate admission_key "${options.admissionKey}"`,
      missing_inputs: [],
    });
  }

  const leaseToken = runRecord.lease_token!;
  const leaseGen = runRecord.fencing_generation;

  // Fence all emissions with the active run's lease token and attach run_id / task_id.
  const fencedIngestor: Ingestor = {
    ingest: async (capId, drafts) => {
      assertLeaseValid(deps.db, runRecord.id, leaseToken, leaseGen);
      const tagged = drafts.map((d) =>
        typeof d === "object" && d !== null
          ? {
              ...(d as Record<string, unknown>),
              run_id: runRecord.id,
              ...(options.taskId ? { task_id: options.taskId } : {}),
            }
          : d,
      );
      return deps.actionCenter.ingest(capId, tagged);
    },
  };

  const { context, emitted, missingInputs } = buildRunContext({
    manifest,
    ingestor: fencedIngestor,
    trigger: {
      mode: options.trigger?.mode ?? manifest.trigger.mode,
      firedAt: options.trigger?.firedAt ?? nowIso(),
      ...(options.trigger?.payload !== undefined ? { payload: options.trigger.payload } : {}),
    },
    ...(options.inputs ? { inputs: options.inputs } : {}),
    ...(options.recall ? { recall: options.recall } : {}),
  });

  let cancelReject: ((err: Error) => void) | undefined;
  const cancelPromise = new Promise<never>((_, reject) => {
    cancelReject = reject;
  });

  registerActiveRun(runRecord.id, {
    abort: (reason: string) => {
      cancelReject?.(new RunFailure(reason, "cancelled"));
    },
  });

  try {
    const run = await loadEntrypoint(dir, manifest.entrypoint);
    const result = await withTimeout(
      Promise.race([run(context), cancelPromise]),
      manifest.timeout_ms,
      capabilityId,
    );

    assertLeaseValid(deps.db, runRecord.id, leaseToken, leaseGen);

    const returned: DraftActionItem[] = Array.isArray(result?.action_items)
      ? result.action_items
      : [];
    // Anything already sent through ctx.emit() is upserted, not duplicated:
    // ingest keys on (capability_id, dedupe_key). See buildRunContext.
    const ingest = returned.length
      ? await fencedIngestor.ingest(capabilityId, returned)
      : { accepted: [], rejected: [] };

    const status: RunStatus = result?.status === "error" ? "error" : "ok";
    finishRun(deps.db, runRecord.id, leaseToken, {
      status: status === "ok" ? "succeeded" : "failed",
      ...(status === "error" ? { error: "capability reported status: error" } : {}),
      ...(options.costUsd !== undefined ? { cost_usd: options.costUsd } : {}),
    });
    recordRun(deps.db, capabilityId, status);

    const report = done({
      run_id: runRecord.id,
      capability_id: capabilityId,
      status,
      ...(status === "error" ? { error: "capability reported status: error" } : {}),
      accepted: ingest.accepted.map((a) => ({
        id: a.id,
        dedupe_key: a.dedupe_key,
        status: a.status,
      })),
      rejected: ingest.rejected.map((r) => ({ errors: r.errors })),
      logs: Array.isArray(result?.logs) ? result.logs : [],
      missing_inputs: missingInputs,
    });
    logger.info(
      {
        runId: runRecord.id,
        capability: capabilityId,
        status,
        emitted: emitted.length,
        accepted: report.accepted.length,
      },
      "capability run finished",
    );
    return report;
  } catch (err) {
    const failure =
      err instanceof RunFailure
        ? err
        : err instanceof StaleLeaseError
          ? new RunFailure(err.message, "cancelled")
          : new RunFailure((err as Error).message, "error");

    if (failure.status === "timeout") {
      fenceRun(deps.db, runRecord.id, "timeout", failure.message);
    } else if (failure.status === "cancelled") {
      fenceRun(deps.db, runRecord.id, "cancelled", failure.message);
    } else {
      try {
        finishRun(deps.db, runRecord.id, leaseToken, {
          status: "failed",
          error: failure.message,
        });
      } catch {
        fenceRun(deps.db, runRecord.id, "cancelled", failure.message);
      }
    }

    recordRun(deps.db, capabilityId, failure.status);
    logger.error(
      { runId: runRecord.id, capability: capabilityId, err: failure.message },
      "capability run failed",
    );
    return done({
      ...base,
      run_id: runRecord.id,
      status: failure.status,
      error: failure.message,
      missing_inputs: missingInputs,
    });
  } finally {
    unregisterActiveRun(runRecord.id);
  }
}
