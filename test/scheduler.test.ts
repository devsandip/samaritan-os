import { describe, expect, it } from "vitest";
import { Scheduler, type FireContext } from "../src/scheduler/index.js";
import { runCapability } from "../src/run-layer/index.js";
import { openDatabase, type Db } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";
import { harness, type Harness } from "./helpers.js";

/** Local-time Date, so an expected `next_fire_at` is just `at(...).toISOString()`. */
function at(y: number, month1: number, day: number, hour = 0, min = 0): Date {
  return new Date(y, month1 - 1, day, hour, min, 0, 0);
}

interface SeedOptions {
  cron?: string;
  /** `undefined` seeds NULL (never armed); a Date seeds that instant. */
  nextFireAt?: Date | null;
  enabled?: boolean;
  catchUp?: "skip" | "run_once";
  claudeTaskId?: string | null;
  mode?: string;
}

function seed(db: Db, id: string, opts: SeedOptions = {}): void {
  const cron = opts.cron ?? "0 8 * * *";
  const mode = opts.mode ?? "scheduled";
  const manifest = {
    id,
    trigger: { mode, cron, ...(opts.catchUp ? { catch_up: opts.catchUp } : {}) },
  };
  db.prepare(
    `INSERT INTO capabilities (id, name, version, manifest_json, enabled, registered_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, id, "0.1.0", JSON.stringify(manifest), opts.enabled === false ? 0 : 1, at(2026, 1, 1).toISOString());

  db.prepare(
    `INSERT INTO triggers (id, capability_id, mode, cron, on_events, command, claude_scheduled_task_id, next_fire_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${id}:trigger`,
    id,
    mode,
    cron,
    null,
    null,
    opts.claudeTaskId ?? null,
    opts.nextFireAt === undefined ? null : (opts.nextFireAt?.toISOString() ?? null),
  );
}

function nextFireAt(db: Db, id: string): string | null {
  const row = db
    .prepare<{ next_fire_at: string | null }>("SELECT next_fire_at FROM triggers WHERE capability_id = ?")
    .get(id);
  return row?.next_fire_at ?? null;
}

function scheduler(db: Db, fired: FireContext[]): Scheduler {
  return new Scheduler({ db, fire: async (ctx) => void fired.push(ctx) });
}

function freshDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

describe("Scheduler.tick", () => {
  it("arms a never-seen trigger without firing it", async () => {
    const db = freshDb();
    seed(db, "daily", { cron: "0 8 * * *", nextFireAt: undefined });
    const fired: FireContext[] = [];

    await scheduler(db, fired).tick(at(2026, 7, 21, 7, 0));

    expect(fired).toHaveLength(0);
    expect(nextFireAt(db, "daily")).toBe(at(2026, 7, 21, 8, 0).toISOString());
  });

  it("fires a due trigger once and advances to the next slot", async () => {
    const db = freshDb();
    seed(db, "daily", { cron: "0 8 * * *", nextFireAt: at(2026, 7, 21, 8, 0) });
    const fired: FireContext[] = [];
    const sched = scheduler(db, fired);

    await sched.tick(at(2026, 7, 21, 8, 0));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ capabilityId: "daily", reason: "scheduled" } as never);
    expect(fired[0]!.scheduledFor).toBe(at(2026, 7, 21, 8, 0).toISOString());
    expect(nextFireAt(db, "daily")).toBe(at(2026, 7, 22, 8, 0).toISOString());

    // A second tick at the same instant does not re-fire: the slot was claimed.
    await sched.tick(at(2026, 7, 21, 8, 0));
    expect(fired).toHaveLength(1);
  });

  it("leaves a trigger alone until its slot arrives", async () => {
    const db = freshDb();
    seed(db, "daily", { cron: "0 8 * * *", nextFireAt: at(2026, 7, 22, 8, 0) });
    const fired: FireContext[] = [];

    await scheduler(db, fired).tick(at(2026, 7, 21, 9, 0));

    expect(fired).toHaveLength(0);
    expect(nextFireAt(db, "daily")).toBe(at(2026, 7, 22, 8, 0).toISOString());
  });

  it("coalesces a burst of missed slots into a single fire", async () => {
    const db = freshDb();
    // Due at 08:00 but the tick lands at 10:40; the next slot is 10:45, not 08:15.
    seed(db, "quarterly", { cron: "*/15 * * * *", nextFireAt: at(2026, 7, 21, 8, 0) });
    const fired: FireContext[] = [];

    await scheduler(db, fired).tick(at(2026, 7, 21, 10, 40));

    expect(fired).toHaveLength(1);
    expect(nextFireAt(db, "quarterly")).toBe(at(2026, 7, 21, 10, 45).toISOString());
  });

  it("skips a trigger Claude still owns (§8)", async () => {
    const db = freshDb();
    seed(db, "owned", { nextFireAt: at(2026, 7, 20, 8, 0), claudeTaskId: "task_abc" });
    const fired: FireContext[] = [];

    await scheduler(db, fired).tick(at(2026, 7, 21, 9, 0));

    expect(fired).toHaveLength(0);
    // Untouched: it is not this scheduler's to arm.
    expect(nextFireAt(db, "owned")).toBe(at(2026, 7, 20, 8, 0).toISOString());
  });

  it("arms a disabled capability forward but never runs it", async () => {
    const db = freshDb();
    seed(db, "off", { nextFireAt: at(2026, 7, 21, 8, 0), enabled: false });
    const fired: FireContext[] = [];

    await scheduler(db, fired).tick(at(2026, 7, 21, 8, 0));

    expect(fired).toHaveLength(0);
    // Advanced, so re-enabling later does not replay every slept-through slot.
    expect(nextFireAt(db, "off")).toBe(at(2026, 7, 22, 8, 0).toISOString());
  });

  it("isolates a bad cron so the other triggers still fire", async () => {
    const db = freshDb();
    // A cron the registry would reject, forced straight into the table.
    seed(db, "broken", { cron: "0 8 * * *", nextFireAt: at(2026, 7, 21, 8, 0) });
    db.prepare("UPDATE triggers SET cron = 'not a cron' WHERE capability_id = ?").run("broken");
    seed(db, "healthy", { cron: "0 8 * * *", nextFireAt: at(2026, 7, 21, 8, 0) });
    const fired: FireContext[] = [];

    await expect(scheduler(db, fired).tick(at(2026, 7, 21, 8, 0))).resolves.toBeUndefined();

    expect(fired.map((f) => f.capabilityId)).toEqual(["healthy"]);
  });

  it("does not let one failing fire stop the tick", async () => {
    const db = freshDb();
    seed(db, "throws", { nextFireAt: at(2026, 7, 21, 8, 0) });
    seed(db, "ok", { nextFireAt: at(2026, 7, 21, 8, 0) });
    const fired: FireContext[] = [];
    const sched = new Scheduler({
      db,
      fire: async (ctx) => {
        if (ctx.capabilityId === "throws") throw new Error("boom");
        fired.push(ctx);
      },
    });

    await expect(sched.tick(at(2026, 7, 21, 8, 0))).resolves.toBeUndefined();

    expect(fired.map((f) => f.capabilityId)).toEqual(["ok"]);
    // Both slots were claimed regardless of the failure.
    expect(nextFireAt(db, "throws")).toBe(at(2026, 7, 22, 8, 0).toISOString());
  });
});

describe("Scheduler.reconcile", () => {
  it("arms a never-seen trigger without firing", async () => {
    const db = freshDb();
    seed(db, "daily", { nextFireAt: undefined });
    const fired: FireContext[] = [];

    await scheduler(db, fired).reconcile(at(2026, 7, 21, 9, 0));

    expect(fired).toHaveLength(0);
    expect(nextFireAt(db, "daily")).toBe(at(2026, 7, 22, 8, 0).toISOString());
  });

  it("records a missed run but does not replay it under the default skip policy", async () => {
    const db = freshDb();
    seed(db, "reminder", { nextFireAt: at(2026, 7, 20, 8, 0) }); // yesterday, missed
    const fired: FireContext[] = [];

    await scheduler(db, fired).reconcile(at(2026, 7, 21, 9, 0));

    expect(fired).toHaveLength(0);
    expect(nextFireAt(db, "reminder")).toBe(at(2026, 7, 22, 8, 0).toISOString());
  });

  it("replays a single missed run under catch_up: run_once", async () => {
    const db = freshDb();
    seed(db, "digest", { nextFireAt: at(2026, 7, 20, 8, 0), catchUp: "run_once" });
    const fired: FireContext[] = [];

    await scheduler(db, fired).reconcile(at(2026, 7, 21, 9, 0));

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ capabilityId: "digest", reason: "catch_up" } as never);
    expect(nextFireAt(db, "digest")).toBe(at(2026, 7, 22, 8, 0).toISOString());
  });

  it("replays exactly once however many runs were missed", async () => {
    const db = freshDb();
    // Down for three days; a daily run_once digest catches up once, not three times.
    seed(db, "digest", { nextFireAt: at(2026, 7, 18, 8, 0), catchUp: "run_once" });
    const fired: FireContext[] = [];

    await scheduler(db, fired).reconcile(at(2026, 7, 21, 9, 0));

    expect(fired).toHaveLength(1);
  });

  it("does not replay a run_once trigger that is disabled", async () => {
    const db = freshDb();
    seed(db, "digest", { nextFireAt: at(2026, 7, 20, 8, 0), catchUp: "run_once", enabled: false });
    const fired: FireContext[] = [];

    await scheduler(db, fired).reconcile(at(2026, 7, 21, 9, 0));

    expect(fired).toHaveLength(0);
    expect(nextFireAt(db, "digest")).toBe(at(2026, 7, 22, 8, 0).toISOString());
  });

  it("leaves a future slot untouched", async () => {
    const db = freshDb();
    seed(db, "daily", { nextFireAt: at(2026, 7, 22, 8, 0), catchUp: "run_once" });
    const fired: FireContext[] = [];

    await scheduler(db, fired).reconcile(at(2026, 7, 21, 9, 0));

    expect(fired).toHaveLength(0);
    expect(nextFireAt(db, "daily")).toBe(at(2026, 7, 22, 8, 0).toISOString());
  });
});

describe("Scheduler lifecycle", () => {
  it("reconciles once on start, so a missed run_once fires immediately", async () => {
    const db = freshDb();
    seed(db, "digest", { nextFireAt: at(2000, 1, 1, 8, 0), catchUp: "run_once" });
    const fired: FireContext[] = [];
    const sched = new Scheduler({
      db,
      now: () => new Date(),
      fire: async (ctx) => void fired.push(ctx),
    });

    await sched.start();
    sched.stop();

    expect(fired).toHaveLength(1);
    expect(fired[0]!.reason).toBe("catch_up");
  });

  it("upcoming() reports owned triggers and hides Claude-owned ones", () => {
    const db = freshDb();
    seed(db, "mine", { cron: "0 8 * * *", nextFireAt: at(2026, 7, 22, 8, 0) });
    seed(db, "claude", { nextFireAt: at(2026, 7, 22, 8, 0), claudeTaskId: "task_x" });

    const rows = scheduler(db, []).upcoming();

    expect(rows).toEqual([
      { capability_id: "mine", cron: "0 8 * * *", next_fire_at: at(2026, 7, 22, 8, 0).toISOString() },
    ]);
  });
});

/**
 * The unit tests above inject `fire`. These run the real thing: the Scheduler
 * wired to the real Run Layer, firing a real capability from the real roster,
 * so the seam between "a slot came due" and "an item landed in the Inbox" is
 * covered end to end. `weekly-digest` is the one that fires cleanly with no
 * inputs — it writes an honest empty-week digest and auto-completes.
 */
describe("Scheduler end to end", () => {
  function wireRealFire(h: Harness): Scheduler {
    return new Scheduler({
      db: h.db,
      fire: async (ctx) => {
        await runCapability(
          { db: h.db, capabilities: h.capabilities, actionCenter: h.actionCenter },
          ctx.capabilityId,
          { trigger: { mode: "scheduled", firedAt: ctx.scheduledFor } },
        );
      },
    });
  }

  function statusOf(h: Harness, capabilityId: string): { count: number; lastStatus: string | null } {
    const count = h.db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM action_items WHERE capability_id = ?")
      .get(capabilityId);
    const cap = h.db
      .prepare<{ last_run_status: string | null }>(
        "SELECT last_run_status FROM capabilities WHERE id = ?",
      )
      .get(capabilityId);
    return { count: count?.n ?? 0, lastStatus: cap?.last_run_status ?? null };
  }

  it("fires a due weekly-digest through the Run Layer and lands an item", async () => {
    const h = harness();
    // The real registry already seeded the trigger row from the manifest; make
    // its slot due.
    h.db
      .prepare("UPDATE triggers SET next_fire_at = ? WHERE capability_id = 'weekly-digest'")
      .run(at(2026, 7, 19, 20, 0).toISOString());

    await wireRealFire(h).tick(at(2026, 7, 21, 12, 0));

    const { count, lastStatus } = statusOf(h, "weekly-digest");
    expect(count).toBe(1);
    expect(lastStatus).toBe("ok");

    // Advanced to the next Sunday 20:00, not left in the past.
    const next = nextFireAt(h.db, "weekly-digest");
    expect(next).not.toBeNull();
    const nextDate = new Date(next!);
    expect(nextDate.getTime()).toBeGreaterThan(at(2026, 7, 21, 12, 0).getTime());
    expect(nextDate.getDay()).toBe(0);
    expect(nextDate.getHours()).toBe(20);
  });

  it("replays the digest on reconcile because its manifest opts into run_once", async () => {
    const h = harness();
    h.db
      .prepare("UPDATE triggers SET next_fire_at = ? WHERE capability_id = 'weekly-digest'")
      .run(at(2026, 7, 12, 20, 0).toISOString()); // a Sunday two weeks back, missed

    await wireRealFire(h).reconcile(at(2026, 7, 21, 12, 0));

    // run_once (set on the real manifest) replays exactly one catch-up run.
    expect(statusOf(h, "weekly-digest")).toEqual({ count: 1, lastStatus: "ok" });
  });
});
