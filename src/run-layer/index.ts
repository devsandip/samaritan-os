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
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "../logger.js";
import type { CapabilityRegistry } from "../registry/index.js";
import type { Db } from "../store/db.js";
import { nowIso, type DraftActionItem } from "../types/index.js";
import {
  buildRunContext,
  type CapabilityEntrypoint,
  type Ingestor,
  type RecallAnswer,
  type RunResult,
  type RunTrigger,
} from "./context.js";

const logger = log("run-layer");

export type RunStatus = "ok" | "error" | "timeout" | "skipped";

export interface RunReport {
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
  /** Run even when the manifest says `enabled: false`. Used by the CLI's --force. */
  force?: boolean;
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

  const { context, emitted, missingInputs } = buildRunContext({
    manifest,
    ingestor: deps.actionCenter,
    trigger: {
      mode: options.trigger?.mode ?? manifest.trigger.mode,
      firedAt: options.trigger?.firedAt ?? nowIso(),
      ...(options.trigger?.payload !== undefined ? { payload: options.trigger.payload } : {}),
    },
    ...(options.inputs ? { inputs: options.inputs } : {}),
    ...(options.recall ? { recall: options.recall } : {}),
  });

  try {
    const run = await loadEntrypoint(dir, manifest.entrypoint);
    const result = await withTimeout(run(context), manifest.timeout_ms, capabilityId);

    const returned: DraftActionItem[] = Array.isArray(result?.action_items)
      ? result.action_items
      : [];
    // Anything already sent through ctx.emit() is upserted, not duplicated:
    // ingest keys on (capability_id, dedupe_key). See buildRunContext.
    const ingest = returned.length
      ? await deps.actionCenter.ingest(capabilityId, returned)
      : { accepted: [], rejected: [] };

    const status: RunStatus = result?.status === "error" ? "error" : "ok";
    recordRun(deps.db, capabilityId, status);

    const report = done({
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
      { capability: capabilityId, status, emitted: emitted.length, accepted: report.accepted.length },
      "capability run finished",
    );
    return report;
  } catch (err) {
    const failure =
      err instanceof RunFailure ? err : new RunFailure((err as Error).message, "error");
    recordRun(deps.db, capabilityId, failure.status);
    logger.error({ capability: capabilityId, err: failure.message }, "capability run failed");
    return done({
      ...base,
      status: failure.status,
      error: failure.message,
      missing_inputs: missingInputs,
    });
  }
}
