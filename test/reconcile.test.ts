/**
 * Boot reconciliation (TECH-SPEC §11).
 *
 * `approved` is the one status a healthy daemon never leaves an item sitting in:
 * `execute()` writes it, dispatches, and writes the outcome inside a single turn.
 * So an item found `approved` at boot is a crash caught mid-handoff — and it is
 * invisible, because `approved` is not a reviewable state, until something
 * re-drives it. `reconcile()` is that something. These tests pin the recovery,
 * and above all that it never re-runs work a prior attempt already settled.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { harness, spyAdapter, testDraft, testExecution, type Harness } from "./helpers.js";
import { createActionItem, getActionItem, transition } from "../src/store/action-items.js";
import type { Db } from "../src/store/db.js";

const CAP = "test.recover.create";

/**
 * A full harness plus the one capabilities row and one adapter these tests need.
 * The `test-cap` row satisfies the action_items → capabilities foreign key
 * (foreign keys are enforced on this connection); the spy adapter is the
 * execution target the seeded items dispatch to.
 */
function recoverHarness(): Harness & { adapter: ReturnType<typeof spyAdapter> } {
  const h = harness();
  h.db
    .prepare(
      `INSERT INTO capabilities (id, name, version, manifest_json, registered_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("test-cap", "Test Capability", "0.1.0", "{}", new Date().toISOString());
  const adapter = spyAdapter(CAP);
  h.execution.register(adapter);
  return { ...h, adapter };
}

/** Seeds one row in the executions ledger, as a prior (crashed) attempt would leave it. */
function seedExecution(
  db: Db,
  o: { itemId: string; key: string; status: string; attempt?: number; guidedLink?: string },
): void {
  db.prepare(
    `INSERT INTO executions
       (id, action_item_id, mode, capability, idempotency_key, attempt, status, started_at, guided_link)
     VALUES (?, ?, 'automated', ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    o.itemId,
    CAP,
    o.key,
    o.attempt ?? 1,
    o.status,
    new Date().toISOString(),
    o.guidedLink ?? null,
  );
}

/** A fresh `pending` item targeting the spy adapter, with a unique dedupe key. */
function pendingItem(db: Db) {
  return createActionItem(
    db,
    testDraft({
      dedupe_key: `sha256:${randomUUID()}`,
      execution: testExecution({ capability: CAP, mode: "automated" }),
    }),
  );
}

/**
 * An item parked in `approved`, exactly as respond()/auto-complete leaves it the
 * instant before execute() dispatches — the frame a crash freezes.
 */
function approvedItem(db: Db) {
  return transition(db, {
    id: pendingItem(db).id,
    to: "approved",
    actor: "sandip",
    reason: "approved just before the crash",
  });
}

describe("Registry.reconcileStalePending", () => {
  it("fails pending rows, leaves settled ones, and returns the count", () => {
    const { db, execution } = recoverHarness();
    const [ia, ib, ic] = [pendingItem(db).id, pendingItem(db).id, pendingItem(db).id];
    seedExecution(db, { itemId: ia, key: "a:0", status: "pending" });
    seedExecution(db, { itemId: ib, key: "b:0", status: "succeeded" });
    seedExecution(db, { itemId: ic, key: "c:0", status: "staged" });

    expect(execution.reconcileStalePending()).toBe(1);

    const byKey = (k: string) =>
      db
        .prepare<{ status: string; error: string | null }>(
          "SELECT status, error FROM executions WHERE idempotency_key = ?",
        )
        .get(k)!;
    expect(byKey("a:0")).toMatchObject({ status: "failed", error: "interrupted by restart" });
    expect(byKey("b:0").status).toBe("succeeded");
    expect(byKey("c:0").status).toBe("staged");
  });
});

describe("ActionCenter.reconcile", () => {
  it("re-drives an approved item that never reached the registry (§11 case 1)", async () => {
    const { db, actionCenter, adapter } = recoverHarness();
    const item = approvedItem(db);

    expect(await actionCenter.reconcile()).toBe(1);

    expect(getActionItem(db, item.id)!.status).toBe("executed");
    expect(adapter.calls).toHaveLength(1); // it ran, because nothing had settled
  });

  it("replays a settled attempt instead of dispatching again (§11 case 3)", async () => {
    const { db, actionCenter, adapter } = recoverHarness();
    const item = approvedItem(db);
    // The adapter had already staged before the crash; only the item transition
    // was lost. dispatchKey for a never-reopened item is `${id}:0`.
    seedExecution(db, {
      itemId: item.id,
      key: `${item.id}:0`,
      status: "staged",
      guidedLink: "https://example/staged",
    });

    expect(await actionCenter.reconcile()).toBe(1);

    const recovered = getActionItem(db, item.id)!;
    expect(recovered.status).toBe("awaiting_confirmation");
    expect(recovered.execution.payload._guided_link).toBe("https://example/staged");
    expect(adapter.calls).toHaveLength(0); // replayed — no second external effect
  });

  it("fails the stale pending attempt, then re-drives (§11 case 2)", async () => {
    const { db, actionCenter, adapter } = recoverHarness();
    const item = approvedItem(db);
    seedExecution(db, { itemId: item.id, key: `${item.id}:0`, status: "pending", attempt: 1 });

    expect(await actionCenter.reconcile()).toBe(1);

    expect(getActionItem(db, item.id)!.status).toBe("executed");
    expect(adapter.calls).toHaveLength(1);
    const rows = db
      .prepare<{ attempt: number; status: string }>(
        "SELECT attempt, status FROM executions WHERE action_item_id = ? ORDER BY attempt",
      )
      .all(item.id);
    expect(rows).toEqual([
      { attempt: 1, status: "failed" }, // the crashed attempt, corrected
      { attempt: 2, status: "succeeded" }, // the clean re-drive
    ]);
  });

  it("touches only approved items and returns how many it re-drove", async () => {
    const { db, actionCenter, adapter } = recoverHarness();
    const a1 = approvedItem(db);
    const a2 = approvedItem(db);
    const left = pendingItem(db);

    expect(await actionCenter.reconcile()).toBe(2);

    expect(getActionItem(db, a1.id)!.status).toBe("executed");
    expect(getActionItem(db, a2.id)!.status).toBe("executed");
    expect(getActionItem(db, left.id)!.status).toBe("pending"); // never touched
    expect(adapter.calls).toHaveLength(2);
  });
});
