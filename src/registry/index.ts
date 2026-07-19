/**
 * Capability Registry and loader (TECH-SPEC §2.2, §12 step 4).
 *
 * Walks `capabilities/*​/manifest.yaml`, validates each one, cross-checks its
 * execution targets against the Execution Registry, and persists the parsed
 * manifest into the `capabilities` table as the source of truth every other
 * component reads.
 *
 * This is where pluggability is actually enforced: adding a capability is
 * dropping a folder here, and nothing in this file knows the name of any
 * particular capability.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { log } from "../logger.js";
import { allowedVariables, compilePredicate } from "../policy/index.js";
import type { Db } from "../store/db.js";
import {
  CapabilityManifest,
  customAttributesSchema,
  nowIso,
  type ActionItemTypeSpec,
  type ExecutionMode,
} from "../types/index.js";

const logger = log("registry");

export interface LoadedType {
  spec: ActionItemTypeSpec;
  /** Runtime validator for this type's `custom` payload, built from the manifest. */
  customSchema: z.ZodType<Record<string, unknown>>;
  /**
   * The mode this type will actually execute in. Equal to `spec.execution.mode`
   * unless the execution target is missing from the Execution Registry, in which
   * case §10 degrades it to guided so the action still completes by hand.
   */
  effectiveMode: ExecutionMode;
  degradedReason?: string;
}

export interface LoadedCapability {
  manifest: CapabilityManifest;
  dir: string;
  types: Map<string, LoadedType>;
}

export interface LoadProblem {
  dir: string;
  capabilityId?: string;
  message: string;
}

export interface LoadResult {
  loaded: LoadedCapability[];
  problems: LoadProblem[];
}

/** Just enough of the Execution Registry for the cross-check, so the loader does not depend on the whole thing. */
export interface ExecutionCatalogue {
  has(executionCapabilityId: string): boolean;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

/** Reads and validates one capability folder. Never throws; problems are returned. */
function loadOne(dir: string, catalogue: ExecutionCatalogue): LoadedCapability | LoadProblem {
  const manifestPath = join(dir, "manifest.yaml");

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { dir, message: `could not read manifest.yaml: ${(err as Error).message}` };
  }

  const parsed = CapabilityManifest.safeParse(raw);
  if (!parsed.success) {
    return { dir, message: `invalid manifest: ${formatZodError(parsed.error)}` };
  }
  const manifest = parsed.data;

  const types = new Map<string, LoadedType>();
  for (const spec of manifest.emits) {
    const attributeNames = Object.keys(spec.custom_attributes);

    // §5.6: a predicate may only reference variables that will actually be on
    // the item. Catching that here means a typo fails at load, not silently at
    // ingest six hours later.
    const scope = allowedVariables(attributeNames);
    for (const [field, expression] of [
      ["escalate_when", spec.policy?.escalate_when],
      ["auto_complete_when", spec.policy?.auto_complete_when],
    ] as const) {
      if (!expression) continue;
      try {
        compilePredicate(expression, scope);
      } catch (err) {
        return {
          dir,
          capabilityId: manifest.id,
          message: `emits[${spec.type}].policy.${field}: ${(err as Error).message}`,
        };
      }
    }

    // §10: a missing integration degrades the type to guided rather than failing
    // the whole capability. Once the integration connects, the next reload
    // restores the declared mode with no manifest edit.
    const target = spec.execution.capability;
    const available = catalogue.has(target);
    types.set(spec.type, {
      spec,
      customSchema: customAttributesSchema(spec.custom_attributes),
      effectiveMode: available ? spec.execution.mode : "guided",
      ...(available
        ? {}
        : { degradedReason: `"${target}" is not registered in the Execution Registry` }),
    });
  }

  return { manifest, dir, types };
}

function isProblem(x: LoadedCapability | LoadProblem): x is LoadProblem {
  return "message" in x;
}

function persist(db: Db, capability: LoadedCapability): void {
  const { manifest } = capability;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO capabilities (id, name, version, manifest_json, enabled, registered_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         version = excluded.version,
         manifest_json = excluded.manifest_json,
         enabled = excluded.enabled`,
    ).run(
      manifest.id,
      manifest.name,
      manifest.version,
      JSON.stringify(manifest),
      manifest.enabled ? 1 : 0,
      nowIso(),
    );

    // Triggers are rebuilt wholesale on each load. The one field worth carrying
    // across is claude_scheduled_task_id: §8 makes that push-registered by a
    // Claude-owned task, and dropping it would make the in-process scheduler
    // think it owns a trigger Claude is still firing, double-firing it.
    const existing = db
      .prepare<{ claude_scheduled_task_id: string | null }>(
        "SELECT claude_scheduled_task_id FROM triggers WHERE capability_id = ? LIMIT 1",
      )
      .get(manifest.id);

    db.prepare("DELETE FROM triggers WHERE capability_id = ?").run(manifest.id);
    db.prepare(
      `INSERT INTO triggers (id, capability_id, mode, cron, on_events, command, claude_scheduled_task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${manifest.id}:trigger`,
      manifest.id,
      manifest.trigger.mode,
      manifest.trigger.cron ?? null,
      manifest.trigger.on ? JSON.stringify(manifest.trigger.on) : null,
      manifest.trigger.command ?? null,
      existing?.claude_scheduled_task_id ?? null,
    );
  });
}

export interface RegistryOptions {
  db: Db;
  capabilitiesDir: string;
  executionCatalogue: ExecutionCatalogue;
}

export class CapabilityRegistry {
  #capabilities = new Map<string, LoadedCapability>();
  #problems: LoadProblem[] = [];

  constructor(private readonly options: RegistryOptions) {}

  /** Re-walks the capabilities folder. Safe to call at runtime (POST /api/capabilities/reload). */
  reload(): LoadResult {
    const { capabilitiesDir, db, executionCatalogue } = this.options;

    let entries: string[];
    try {
      entries = readdirSync(capabilitiesDir);
    } catch {
      logger.warn({ capabilitiesDir }, "capabilities directory not found; registry is empty");
      this.#capabilities = new Map();
      this.#problems = [];
      return { loaded: [], problems: [] };
    }

    const loaded: LoadedCapability[] = [];
    const problems: LoadProblem[] = [];

    for (const entry of entries.sort()) {
      const dir = join(capabilitiesDir, entry);
      if (entry.startsWith(".") || !statSync(dir).isDirectory()) continue;

      const result = loadOne(dir, executionCatalogue);
      if (isProblem(result)) {
        problems.push(result);
        logger.error({ dir: result.dir, problem: result.message }, "capability failed to load");
        continue;
      }

      if (result.manifest.id !== entry) {
        problems.push({
          dir,
          capabilityId: result.manifest.id,
          message: `manifest id "${result.manifest.id}" does not match its folder name "${entry}"`,
        });
        continue;
      }

      persist(db, result);
      loaded.push(result);

      for (const [type, loadedType] of result.types) {
        if (loadedType.degradedReason) {
          logger.warn(
            { capability: result.manifest.id, type, reason: loadedType.degradedReason },
            "action-item type degraded to guided",
          );
        }
      }
      logger.info(
        { capability: result.manifest.id, version: result.manifest.version, types: result.types.size },
        "registered capability",
      );
    }

    this.#capabilities = new Map(loaded.map((c) => [c.manifest.id, c]));
    this.#problems = problems;
    return { loaded, problems };
  }

  get(capabilityId: string): LoadedCapability | undefined {
    return this.#capabilities.get(capabilityId);
  }

  getType(capabilityId: string, type: string): LoadedType | undefined {
    return this.#capabilities.get(capabilityId)?.types.get(type);
  }

  all(): LoadedCapability[] {
    return [...this.#capabilities.values()];
  }

  problems(): LoadProblem[] {
    return [...this.#problems];
  }
}
