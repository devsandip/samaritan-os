/**
 * batchRespond through the real ingest + respond path (TECH-SPEC §12 step 23).
 *
 * The risk unit tests prove the gate; this proves the ActionCenter consults it
 * with each item's real persisted context, and that an applied item takes the
 * exact same path as a one-at-a-time approve. Wrap is the vehicle: its `approve`
 * is a committing (`execute`) response and its `reject` is non-committing
 * (`discard`), and `escalate_when: "true"` lands every item `pending` first.
 */
import { describe, expect, it } from "vitest";
import { harness, wrapItem } from "./helpers.js";
import { getActionItem } from "../src/store/action-items.js";

function drafts(specs: { key: string; context?: Record<string, unknown> }[]) {
  return specs.map((s) =>
    wrapItem({
      capability_id: "wrap",
      dedupe_key: `wrap:batch:${s.key}`,
      context: { ...wrapItem().context, ...(s.context ?? {}) },
    }),
  );
}

async function ingestPending(h: ReturnType<typeof harness>, specs: Parameters<typeof drafts>[0]) {
  const result = await h.actionCenter.ingest("wrap", drafts(specs));
  expect(result.rejected).toEqual([]);
  return result.accepted;
}

describe("batchRespond (§12 step 23)", () => {
  it("approves a batch of similar low-risk items in one call", async () => {
    const h = harness();
    const accepted = await ingestPending(h, [{ key: "a" }, { key: "b" }, { key: "c" }]);
    const ids = accepted.map((a) => a.id);

    const out = await h.actionCenter.batchRespond({ ids, response_id: "approve" });

    expect(out.applied.map((o) => o.id).sort()).toEqual([...ids].sort());
    expect(out.skipped).toEqual([]);
    expect(out.errors).toEqual([]);
    // Each applied item left `pending` for a settled/dispatched state — the same
    // outcomes a single approve produces (executed, or staged for confirmation).
    for (const o of out.applied) {
      expect(["executed", "awaiting_confirmation"]).toContain(o.status);
    }
  });

  it("pulls a high-value item out of a committing batch, leaving it untouched", async () => {
    const h = harness(); // default threshold 100
    const accepted = await ingestPending(h, [
      { key: "low1" },
      { key: "rich", context: { value: 500 } },
      { key: "low2" },
    ]);
    const ids = accepted.map((a) => a.id);
    const richId = accepted[1]!.id;

    const out = await h.actionCenter.batchRespond({ ids, response_id: "approve" });

    expect(out.applied).toHaveLength(2);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ id: richId, rule: "risk:value_threshold" });
    // Skipped means genuinely untouched: it is still pending, awaiting a look.
    expect(getActionItem(h.db, richId)?.status).toBe("pending");
  });

  it("pulls an irreversible item out of a committing batch", async () => {
    const h = harness();
    const accepted = await ingestPending(h, [
      { key: "ok" },
      { key: "final", context: { reversibility: "irreversible" } },
    ]);
    const ids = accepted.map((a) => a.id);

    const out = await h.actionCenter.batchRespond({ ids, response_id: "approve" });

    expect(out.applied.map((o) => o.id)).toEqual([accepted[0]!.id]);
    expect(out.skipped[0]).toMatchObject({ id: accepted[1]!.id, rule: "risk:irreversible" });
  });

  it("does not gate a non-committing response: a high-value item still discards", async () => {
    const h = harness();
    const accepted = await ingestPending(h, [
      { key: "n1" },
      { key: "n2", context: { value: 9999, reversibility: "irreversible" } },
    ]);
    const ids = accepted.map((a) => a.id);

    const out = await h.actionCenter.batchRespond({ ids, response_id: "reject" });

    expect(out.applied).toHaveLength(2);
    expect(out.skipped).toEqual([]);
    for (const o of out.applied) expect(o.status).toBe("rejected");
  });

  it("records a per-item error without blocking the rest of the batch", async () => {
    const h = harness();
    const accepted = await ingestPending(h, [{ key: "real" }]);
    const ids = [accepted[0]!.id, "no-such-item"];

    const out = await h.actionCenter.batchRespond({ ids, response_id: "approve" });

    expect(out.applied).toHaveLength(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ id: "no-such-item" });
    expect(out.errors[0]?.reason).toContain("not found");
  });

  it("errors an undeclared response rather than silently skipping it", async () => {
    const h = harness();
    const accepted = await ingestPending(h, [{ key: "x" }]);

    const out = await h.actionCenter.batchRespond({
      ids: accepted.map((a) => a.id),
      response_id: "not-a-response",
    });

    expect(out.applied).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.errors).toHaveLength(1);
  });
});
