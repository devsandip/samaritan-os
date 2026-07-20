/**
 * Demo seeding.
 *
 * The claim under test is not "it makes rows" but "the rows it makes are
 * indistinguishable from real ones". A demo of a review gate lives or dies on
 * whether the audit trail survives being clicked, so most of what is asserted
 * here is about provenance and policy rather than counts.
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { repoRoot } from "../src/config/index.js";
import { act, clearSeeded, runSeed, seedable } from "../src/seed/index.js";
import { listActionItems, listAuditTrail } from "../src/store/action-items.js";

let app: App;

beforeEach(() => {
  app = createApp({
    dbPath: ":memory:",
    capabilitiesDir: join(repoRoot(), "capabilities"),
  });
});

afterEach(() => app.close());

describe("discovery", () => {
  it("finds capabilities by their fixture, not by a list", () => {
    // If this ever needs updating when an agent is added, the seed has become a
    // second registry and will drift from the real one.
    const ids = seedable(app).map((s) => s.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(app.capabilities.get(id)).toBeDefined();
  });

  it("narrows to the requested capability", () => {
    expect(seedable(app, ["wrap"]).map((s) => s.id)).toEqual(["wrap"]);
    expect(seedable(app, ["nonexistent"])).toEqual([]);
  });

  it("carries each fixture's note so --list can say what it demonstrates", () => {
    expect(seedable(app, ["subscription-watch"])[0]?.note).toMatch(/horizon/);
  });
});

describe("what a seeded item looks like", () => {
  it("carries a real policy decision, not a fabricated one", async () => {
    await runSeed(app, { only: ["subscription-watch"], act: false });
    const item = listActionItems(app.db, { capability_id: "subscription-watch" })[0]!;

    const trail = listAuditTrail(app.db, item.id);
    // The creation event, written by ingest with actor "capability". A row
    // inserted directly would have no such event at all.
    expect(trail[0]!.from_status).toBeNull();
    expect(trail[0]!.actor).toBe("capability");
  });

  it("carries the provenance chain the capability actually travelled", async () => {
    await runSeed(app, { only: ["newsletter-digest"], act: false });
    const item = listActionItems(app.db, { capability_id: "newsletter-digest" })[0]!;

    expect(item.context.provenance).toEqual(["email.received", "newsletter-digest.run"]);
    expect(item.context.source.kind).toBe("email");
  });

  it("lets policy decide rather than assigning statuses", async () => {
    const result = await runSeed(app, { only: ["newsletter-digest"], act: false });
    const statuses = result.reports[0]!.report.accepted.map((a) => a.status).sort();
    // One escalated, one auto-completed, decided by worth_acting at ingest.
    expect(statuses).toEqual(["executed", "pending"]);
  });
});

describe("running it twice", () => {
  it("skips what it already seeded", async () => {
    await runSeed(app, { act: false });
    const first = listActionItems(app.db, { limit: 500 }).length;

    const again = await runSeed(app, { act: false });
    expect(again.reports).toEqual([]);
    expect(again.skipped.length).toBeGreaterThan(0);
    expect(listActionItems(app.db, { limit: 500 })).toHaveLength(first);
  });

  it("does not re-execute an auto-completed capability", async () => {
    // The one that actually costs something. weekly-digest writes to the
    // vault, so a second unguarded run appends the digest a second time.
    await runSeed(app, { only: ["weekly-digest"], act: false });
    const before = app.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM executions").get()?.n;

    await runSeed(app, { only: ["weekly-digest"], act: false });
    expect(app.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM executions").get()?.n).toBe(
      before,
    );
  });

  it("seeds a newly added capability without re-running the others", async () => {
    await runSeed(app, { only: ["wrap"], act: false });
    const result = await runSeed(app, { act: false });

    expect(result.skipped).toEqual(["wrap"]);
    expect(result.reports.map((r) => r.target.id)).not.toContain("wrap");
    expect(result.reports.length).toBeGreaterThan(0);
  });

  it("re-runs on --force, which is how you say you meant it", async () => {
    await runSeed(app, { only: ["wrap"], act: false });
    const before = listActionItems(app.db, { capability_id: "wrap" }).length;

    const forced = await runSeed(app, { only: ["wrap"], act: false, force: true });
    expect(forced.skipped).toEqual([]);
    // Unsettled items supersede in place (§5.1 branch 2), so forcing a re-run
    // over a still-pending seed updates rather than duplicates.
    expect(listActionItems(app.db, { capability_id: "wrap" })).toHaveLength(before);
  });
});

describe("the act pass", () => {
  it("leaves the deferred, staged and completed views populated", async () => {
    const result = await runSeed(app);
    expect(result.acted.length).toBeGreaterThanOrEqual(3);

    const statuses = new Set(listActionItems(app.db, { limit: 500 }).map((i) => i.status));
    expect(statuses).toContain("deferred");
    expect(statuses).toContain("awaiting_confirmation");
    expect(statuses).toContain("rejected");
    expect(statuses).toContain("executed");
    expect(statuses).toContain("pending");
  });

  it("never approves anything that would reach the outside world", async () => {
    await runSeed(app);

    // Every execution the seed caused must be a guided staging. An automated
    // one means the seed filed something to Notion or TickTick on Sandip's
    // behalf, which is precisely the decision this system exists to keep his.
    const modes = app.db
      .prepare<{ mode: string }>("SELECT DISTINCT mode FROM executions")
      .all()
      .map((row) => row.mode);
    expect(modes.every((mode) => mode !== "assisted")).toBe(true);

    const approvedByHand = listActionItems(app.db, { limit: 500 }).filter(
      (item) => item.status === "awaiting_confirmation",
    );
    for (const item of approvedByHand) expect(item.execution.mode).toBe("guided");
  });

  it("records who answered, so the trail does not claim the OS decided", async () => {
    await runSeed(app);
    const dismissed = listActionItems(app.db, { status: "rejected", limit: 10 })[0]!;

    const trail = listAuditTrail(app.db, dismissed.id);
    expect(trail.at(-1)!.actor).toBe("sandip");
  });

  it("can be skipped, leaving everything pending", async () => {
    const result = await runSeed(app, { act: false });
    expect(result.acted).toEqual([]);

    const statuses = new Set(listActionItems(app.db, { limit: 500 }).map((i) => i.status));
    expect(statuses).not.toContain("deferred");
    expect(statuses).not.toContain("awaiting_confirmation");
  });

  it("is a no-op when there is nothing pending", async () => {
    expect(await act(app, ["wrap"])).toEqual([]);
  });
});

describe("clearing", () => {
  it("resolves open items instead of deleting them", async () => {
    await runSeed(app, { only: ["wrap"], act: false });
    const before = listActionItems(app.db, { capability_id: "wrap" }).length;

    const { cleared } = clearSeeded(app, ["wrap"]);
    expect(cleared).toBe(before);

    // Same rows, different statuses. §9 makes the trail append-only, so an
    // "undo" that erased it would be both impossible and wrong.
    const after = listActionItems(app.db, { capability_id: "wrap" });
    expect(after).toHaveLength(before);
    expect(after.every((item) => item.status === "rejected")).toBe(true);
  });

  it("keeps the audit trail of what it cleared", async () => {
    await runSeed(app, { only: ["wrap"], act: false });
    const item = listActionItems(app.db, { capability_id: "wrap" })[0]!;
    clearSeeded(app, ["wrap"]);

    const trail = listAuditTrail(app.db, item.id);
    expect(trail.at(-1)!.reason).toMatch(/--clear/);
    expect(trail).toHaveLength(2);
  });

  it("skips an item mid-handoff rather than forcing it", async () => {
    // An item in awaiting_confirmation is waiting on a confirmation the OS
    // cannot give itself. Refusing to clear it is the store being right.
    await runSeed(app);
    const staged = listActionItems(app.db, { status: "awaiting_confirmation", limit: 10 });
    expect(staged.length).toBeGreaterThan(0);

    clearSeeded(app, seedable(app).map((s) => s.id));
    expect(listActionItems(app.db, { status: "awaiting_confirmation", limit: 10 })).toHaveLength(
      staged.length,
    );
  });
});

describe("the act pass, on a repeat run", () => {
  it("does not keep eating the Inbox it was asked to fill", async () => {
    await runSeed(app);
    const inbox = listActionItems(app.db, { status: "pending", limit: 500 }).length;

    // Nothing new to seed, so nothing to answer. Without this guard a second
    // run defers and dismisses three more items every time it is invoked.
    const again = await runSeed(app);
    expect(again.acted).toEqual([]);
    expect(listActionItems(app.db, { status: "pending", limit: 500 })).toHaveLength(inbox);
  });
});
