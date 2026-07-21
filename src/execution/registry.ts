/**
 * Execution Registry (TECH-SPEC §5.3, §12 step 8).
 *
 * The catalogue of what the OS can actually do, and the one place an external
 * side effect is allowed to originate. Dispatches by mode, records every attempt
 * in `executions`, and enforces idempotency so a retry after a client-side
 * timeout cannot double-execute work the provider already committed (§10).
 */
import { randomUUID } from "node:crypto";
import { isMoneyLockedExecutionId, MoneyLockViolation } from "../guardrails.js";
import { log } from "../logger.js";
import type { Db } from "../store/db.js";
import {
  nowIso,
  type ConnectionStatus,
  type ExecutionAdapter,
  type ExecutionCapability,
  type ExecutionRegistry as ExecutionRegistryContract,
  type ExecutionRequest,
  type ExecutionResult,
} from "../types/index.js";

const logger = log("execution");

export class UnknownExecutionCapabilityError extends Error {
  constructor(readonly capability: string) {
    super(`no adapter registered for execution capability "${capability}"`);
    this.name = "UnknownExecutionCapabilityError";
  }
}

export class UnsupportedModeError extends Error {
  constructor(
    readonly capability: string,
    readonly mode: string,
  ) {
    super(`adapter "${capability}" does not support ${mode} mode`);
    this.name = "UnsupportedModeError";
  }
}

interface ExecutionRow {
  id: string;
  status: string;
  attempt: number;
  result_json: string | null;
  error: string | null;
  guided_link: string | null;
  guided_instructions: string | null;
}

export class Registry implements ExecutionRegistryContract {
  readonly #adapters = new Map<string, ExecutionAdapter>();

  constructor(private readonly db: Db) {}

  register(adapter: ExecutionAdapter): void {
    // §9 layer 3. An adapter claiming automated for a money-namespaced id is
    // refused at load time, so no such adapter is ever allowed to exist. This is
    // the layer that cannot be edited around: the routing lock is a data flag
    // and the policy rule reads a manifest, but this is a hard throw on boot.
    if (adapter.modes.includes("automated") && isMoneyLockedExecutionId(adapter.id)) {
      throw new MoneyLockViolation(adapter.id, "automated");
    }
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`execution capability "${adapter.id}" is already registered`);
    }
    this.#adapters.set(adapter.id, adapter);
    logger.debug({ id: adapter.id, modes: adapter.modes }, "registered adapter");
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  get(id: string): ExecutionAdapter | undefined {
    return this.#adapters.get(id);
  }

  capabilities(): ExecutionCapability[] {
    return [...this.#adapters.values()].map((adapter) => {
      const connection = this.db
        .prepare<{ status: string; account: string | null; last_verified_at: string | null }>(
          "SELECT status, account, last_verified_at FROM connections WHERE id = ?",
        )
        .get(adapter.id);
      return {
        id: adapter.id,
        provider: adapter.provider,
        description: adapter.description,
        modes_supported: adapter.modes,
        adapter: adapter.id,
        scopes_required: adapter.scopes_required ?? [],
        status: (connection?.status as ConnectionStatus) ?? "not_configured",
        ...(connection?.account ? { account: connection.account } : {}),
        ...(connection?.last_verified_at ? { last_verified_at: connection.last_verified_at } : {}),
      };
    });
  }

  /** Runs every adapter's verify() and records the result in `connections`. */
  async verifyAll(): Promise<void> {
    for (const adapter of this.#adapters.values()) {
      let status: ConnectionStatus = "not_configured";
      try {
        status = adapter.verify ? await adapter.verify() : "connected";
      } catch (err) {
        status = "error";
        logger.warn({ id: adapter.id, err: (err as Error).message }, "verify failed");
      }
      this.db
        .prepare(
          `INSERT INTO connections (id, provider, status, last_verified_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status,
                                         last_verified_at = excluded.last_verified_at`,
        )
        .run(adapter.id, adapter.provider, status, nowIso());
    }
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const adapter = this.#adapters.get(request.capability);
    if (!adapter) throw new UnknownExecutionCapabilityError(request.capability);
    if (!adapter.modes.includes(request.mode)) {
      throw new UnsupportedModeError(request.capability, request.mode);
    }

    // A prior attempt under this key that already settled is authoritative.
    // Replaying it is what makes retry-after-timeout safe at the registry level,
    // before the adapter's own check-or-create even comes into play.
    const settled = this.db
      .prepare<ExecutionRow>(
        `SELECT * FROM executions
          WHERE idempotency_key = ? AND status IN ('succeeded', 'staged')
          ORDER BY attempt DESC LIMIT 1`,
      )
      .get(request.idempotency_key);
    if (settled) {
      logger.info(
        { idempotency_key: request.idempotency_key, attempt: settled.attempt },
        "replaying settled execution instead of re-running it",
      );
      return {
        status: settled.status as ExecutionResult["status"],
        ...(settled.result_json ? { result: JSON.parse(settled.result_json) } : {}),
        // A staged replay without these is a "staged" the caller cannot act on:
        // the link is the whole point of the result, and re-deriving it means
        // dispatching again, which is the one thing the replay exists to avoid.
        ...(settled.guided_link ? { guided_link: settled.guided_link } : {}),
        ...(settled.guided_instructions
          ? { guided_instructions: settled.guided_instructions }
          : {}),
      };
    }

    const prior = this.db
      .prepare<{ attempt: number | null }>(
        "SELECT MAX(attempt) AS attempt FROM executions WHERE idempotency_key = ?",
      )
      .get(request.idempotency_key);
    const attempt = (prior?.attempt ?? 0) + 1;
    const executionId = randomUUID();

    this.db
      .prepare(
        `INSERT INTO executions
           (id, action_item_id, mode, capability, idempotency_key, attempt, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        executionId,
        request.action_item_id,
        request.mode,
        request.capability,
        request.idempotency_key,
        attempt,
        nowIso(),
      );

    let result: ExecutionResult;
    try {
      result = await adapter.execute(request);
    } catch (err) {
      result = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }

    this.db
      .prepare(
        `UPDATE executions
            SET status = ?, result_json = ?, error = ?,
                guided_link = ?, guided_instructions = ?, finished_at = ?
          WHERE id = ?`,
      )
      .run(
        result.status,
        result.result ? JSON.stringify(result.result) : null,
        result.error ?? null,
        result.guided_link ?? null,
        result.guided_instructions ?? null,
        nowIso(),
        executionId,
      );

    logger.info(
      { capability: request.capability, mode: request.mode, status: result.status, attempt },
      "execution finished",
    );
    return result;
  }

  /**
   * Marks every execution still recorded as `pending` as `failed`, returning how
   * many. This is the ledger half of §11's boot reconciliation.
   *
   * An `execute()` writes the `pending` row, awaits the adapter, then updates the
   * row to its outcome. A process that dies in that await leaves a `pending` row
   * that will never resolve — a permanent lie in the ledger. The replay guard
   * ignores it (it trusts only `succeeded`/`staged`), so it neither blocks nor
   * helps the retry; it just claims forever that an attempt is in flight. The
   * spec's "treated as failed-and-retried, not silently dropped": this method is
   * the failed half, and the caller re-driving the approved item is the retry.
   *
   * Callers must invoke this only when nothing is dispatching — at boot, before
   * the socket opens and the scheduler and listeners start. Then every `pending`
   * row is a crash remnant by construction, so no staleness threshold is needed
   * to tell a dead attempt from a live one: there are no live ones. Run while the
   * daemon is serving and this would fail an execution that is legitimately in
   * flight.
   */
  reconcileStalePending(reason = "interrupted by restart"): number {
    const stale = this.db
      .prepare<{ id: string }>("SELECT id FROM executions WHERE status = 'pending'")
      .all();
    for (const { id } of stale) {
      this.db
        .prepare("UPDATE executions SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .run(reason, nowIso(), id);
    }
    if (stale.length) logger.info({ count: stale.length }, "failed stale pending executions");
    return stale.length;
  }
}
