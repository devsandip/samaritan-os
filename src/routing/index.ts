/**
 * Routing resolver (TECH-SPEC §5.4, §12 step 9).
 *
 * Pure lookup plus a policy check. The only component that translates an
 * abstract action type ("email.send") into a concrete provider, account, mode
 * and Execution Registry id ("gmail.draft.create" on "sandip@work").
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { isMoneyLocked, MoneyLockViolation } from "../guardrails.js";
import { log } from "../logger.js";
import type { Db } from "../store/db.js";
import {
  nowIso,
  RoutingFile,
  type ExecutionMode,
  type RoutingEntry,
  type RoutingResolution,
} from "../types/index.js";

const logger = log("routing");

export class UnknownActionTypeError extends Error {
  constructor(readonly actionType: string) {
    super(`no routing entry for action type "${actionType}"`);
    this.name = "UnknownActionTypeError";
  }
}

export class RoutingLockedError extends Error {
  constructor(readonly actionType: string) {
    super(`routing entry "${actionType}" is locked and cannot be changed`);
    this.name = "RoutingLockedError";
  }
}

interface RoutingRow {
  action_type: string;
  provider: string;
  account: string;
  mode: string;
  fallback_provider: string | null;
  locked: number;
}

/** Loads routing.yaml into `routing_config`, replacing what is there. */
export function loadRoutingFile(db: Db, path: string): RoutingEntry[] {
  if (!existsSync(path)) {
    logger.warn({ path }, "routing.yaml not found; routing table left as-is");
    return [];
  }

  const parsed = RoutingFile.safeParse(parseYaml(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `invalid routing.yaml: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const entries = parsed.data;

  for (const entry of entries) {
    // §9 layer 2. A money-locked type shipping as anything but locked+guided in
    // the file is a config bug, and correcting it silently would hide it.
    if (isMoneyLocked(entry.action_type)) {
      if (!entry.locked || entry.mode !== "guided") {
        throw new MoneyLockViolation(entry.action_type, entry.mode);
      }
    }
  }

  db.transaction(() => {
    for (const entry of entries) {
      db.prepare(
        `INSERT INTO routing_config
           (action_type, provider, account, mode, fallback_provider, locked, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(action_type) DO UPDATE SET
           provider = excluded.provider,
           account = excluded.account,
           mode = excluded.mode,
           fallback_provider = excluded.fallback_provider,
           locked = excluded.locked,
           updated_at = excluded.updated_at`,
      ).run(
        entry.action_type,
        entry.provider,
        entry.account,
        entry.mode,
        entry.fallback_provider ?? null,
        entry.locked ? 1 : 0,
        nowIso(),
      );
    }
  });

  logger.info({ count: entries.length, path }, "loaded routing config");
  return entries;
}

export interface ResolveOptions {
  /**
   * The Execution Registry id the emitting capability declared. Used when the
   * routing entry carries no per-mode override.
   */
  declaredExecutionCapabilityId?: string;
}

export class RoutingResolver {
  /** Per-mode overrides keyed by action type, held from the file rather than the DB. */
  #overrides = new Map<string, Partial<Record<ExecutionMode, string>>>();

  constructor(private readonly db: Db) {}

  /** Records the per-mode execution overrides declared in routing.yaml. */
  setOverrides(entries: RoutingEntry[]): void {
    this.#overrides = new Map(
      entries
        .filter((e) => e.execution_capability)
        .map((e) => [e.action_type, e.execution_capability!]),
    );
  }

  list(): RoutingEntry[] {
    return this.db
      .prepare<RoutingRow>("SELECT * FROM routing_config ORDER BY action_type")
      .all()
      .map((r) => this.#rowToEntry(r));
  }

  #rowToEntry(row: RoutingRow): RoutingEntry {
    return {
      action_type: row.action_type,
      provider: row.provider,
      account: row.account,
      mode: row.mode as ExecutionMode,
      ...(row.fallback_provider ? { fallback_provider: row.fallback_provider } : {}),
      ...(this.#overrides.has(row.action_type)
        ? { execution_capability: this.#overrides.get(row.action_type)! }
        : {}),
      locked: row.locked === 1,
    };
  }

  resolve(actionType: string, opts: ResolveOptions = {}): RoutingResolution {
    const row = this.db
      .prepare<RoutingRow>("SELECT * FROM routing_config WHERE action_type = ?")
      .get(actionType);
    if (!row) throw new UnknownActionTypeError(actionType);

    const mode = row.mode as ExecutionMode;
    const override = this.#overrides.get(actionType)?.[mode];
    const executionCapabilityId = override ?? opts.declaredExecutionCapabilityId;

    if (!executionCapabilityId) {
      throw new Error(
        `routing "${actionType}" resolved to mode "${mode}" but no execution ` +
          `capability is known: the routing entry declares no override for that ` +
          `mode and the caller supplied no declared capability id`,
      );
    }

    return {
      provider: row.provider,
      account: row.account,
      mode,
      locked: row.locked === 1,
      execution_capability_id: executionCapabilityId,
    };
  }

  /**
   * Changes an entry's mode (PUT /api/routing/:action_type).
   * Throws RoutingLockedError on a locked entry, which the API surfaces as 409.
   */
  update(
    actionType: string,
    patch: { provider?: string; account?: string; mode?: ExecutionMode },
  ): RoutingEntry {
    const row = this.db
      .prepare<RoutingRow>("SELECT * FROM routing_config WHERE action_type = ?")
      .get(actionType);
    if (!row) throw new UnknownActionTypeError(actionType);
    if (row.locked === 1) throw new RoutingLockedError(actionType);

    // Belt and braces: even an unlocked row for a money-namespaced type cannot
    // be promoted. The lock flag is data and data can be edited; this is code.
    if (patch.mode && patch.mode !== "guided" && isMoneyLocked(actionType)) {
      throw new MoneyLockViolation(actionType, patch.mode);
    }

    this.db
      .prepare(
        `UPDATE routing_config SET provider = ?, account = ?, mode = ?, updated_at = ?
          WHERE action_type = ?`,
      )
      .run(
        patch.provider ?? row.provider,
        patch.account ?? row.account,
        patch.mode ?? row.mode,
        nowIso(),
        actionType,
      );

    return this.#rowToEntry(
      this.db
        .prepare<RoutingRow>("SELECT * FROM routing_config WHERE action_type = ?")
        .get(actionType)!,
    );
  }
}
