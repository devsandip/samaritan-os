/**
 * The Scheduler (TECH-SPEC §2.2, §12 step 17).
 *
 * Fires `trigger.mode: scheduled` capabilities on their declared cron. Until now
 * every cron in the roster was a declaration nothing read: `weekly-digest` said
 * "Sunday 20:00" and no Sunday ever fired it. This is the piece that makes the
 * cadence real, in-process, no external cron daemon.
 *
 * Three properties it is built around:
 *
 * - **Ownership (§8).** A trigger whose `claude_scheduled_task_id` is set is
 *   still fired by Claude's own scheduled-task infrastructure; this scheduler
 *   skips it, so nothing double-fires. The cutover is per-capability and manual
 *   (drop the id), never automatic.
 *
 * - **Claim before firing.** `next_fire_at` is advanced to the next occurrence
 *   *before* the run starts, in the same synchronous step that decided it was
 *   due. An overlapping tick, or a run slower than the tick interval, therefore
 *   cannot fire the same slot twice, and a burst of missed minutes coalesces
 *   into one run rather than a storm. The cost is that a crash mid-run loses
 *   that one run; `catch_up: run_once` (below) is the recovery for the runs
 *   where that actually matters.
 *
 * - **Catch-up across a restart (§11).** Because `next_fire_at` is persisted, a
 *   daemon that boots to find it in the past knows a run was missed while it was
 *   down. `reconcile()` decides what to do: `skip` logs a `missed_trigger` and
 *   moves on, `run_once` replays a single run. Both then arm the next future
 *   occurrence, so the miss is handled exactly once.
 *
 * Isolation matches the Run Layer's: one trigger throwing (an unparseable cron
 * that somehow got persisted, a fire that rejects) is caught per-trigger and
 * never stops the others or the tick.
 */
import { log } from "../logger.js";
import type { Db } from "../store/db.js";
import { type CatchUpMode, type CapabilityManifest } from "../types/index.js";
import { nextFireAfter, parseCron, type CronSchedule } from "./cron.js";

const logger = log("scheduler");

/** Why a capability is being fired, threaded into the run's trigger payload and the logs. */
export type FireReason = "scheduled" | "catch_up";

export interface FireContext {
  capabilityId: string;
  cron: string;
  /** ISO of the slot that came due — the `next_fire_at` that triggered this run. */
  scheduledFor: string;
  reason: FireReason;
}

export interface SchedulerDeps {
  db: Db;
  /**
   * Runs one capability. Injected rather than importing the Run Layer directly,
   * so the scheduler's timing logic can be tested without running real
   * capabilities. Must resolve; a rejection is caught and logged, never thrown.
   */
  fire: (ctx: FireContext) => Promise<void>;
  /** The clock. Injected so tests can drive time exactly. Defaults to the wall clock. */
  now?: () => Date;
  /** Tick cadence. Defaults to 60s, matching cron's one-minute granularity. */
  intervalMs?: number;
}

interface ScheduledTriggerRow {
  capabilityId: string;
  cron: string;
  nextFireAt: string | null;
  enabled: number;
  manifestJson: string;
}

/** One scheduled trigger the scheduler owns, as the tick/reconcile loops see it. */
interface ScheduledTrigger {
  capabilityId: string;
  cron: string;
  nextFireAt: string | null;
  enabled: boolean;
  catchUp: CatchUpMode;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class Scheduler {
  readonly #db: Db;
  readonly #fire: SchedulerDeps["fire"];
  readonly #now: () => Date;
  readonly #intervalMs: number;
  /** Compiled schedules, cached by cron string so a tick does not re-parse. */
  readonly #schedules = new Map<string, CronSchedule>();
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;

  constructor(deps: SchedulerDeps) {
    this.#db = deps.db;
    this.#fire = deps.fire;
    this.#now = deps.now ?? (() => new Date());
    this.#intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * The scheduled triggers this scheduler owns: `scheduled` mode, a cron set, and
   * NOT claimed by a Claude scheduled task (§8 ownership rule). Joined to
   * `capabilities` for `enabled` and the manifest, which carries `catch_up`.
   */
  #load(): ScheduledTrigger[] {
    const rows = this.#db
      .prepare<ScheduledTriggerRow>(
        `SELECT t.capability_id AS capabilityId,
                t.cron          AS cron,
                t.next_fire_at  AS nextFireAt,
                c.enabled       AS enabled,
                c.manifest_json AS manifestJson
         FROM triggers t
         JOIN capabilities c ON c.id = t.capability_id
         WHERE t.mode = 'scheduled'
           AND t.claude_scheduled_task_id IS NULL
           AND t.cron IS NOT NULL`,
      )
      .all();

    return rows.map((row) => ({
      capabilityId: row.capabilityId,
      cron: row.cron,
      nextFireAt: row.nextFireAt,
      enabled: row.enabled === 1,
      catchUp: catchUpOf(row.manifestJson),
    }));
  }

  #compile(cron: string): CronSchedule {
    let schedule = this.#schedules.get(cron);
    if (!schedule) {
      schedule = parseCron(cron);
      this.#schedules.set(cron, schedule);
    }
    return schedule;
  }

  /** Persists the next fire time so a restart can tell whether a run was missed. */
  #arm(capabilityId: string, when: Date): void {
    this.#db
      .prepare("UPDATE triggers SET next_fire_at = ? WHERE capability_id = ?")
      .run(when.toISOString(), capabilityId);
  }

  async #safeFire(ctx: FireContext): Promise<void> {
    try {
      await this.#fire(ctx);
    } catch (err) {
      // The Run Layer already isolates a capability's own failure; this catches
      // anything the injected fire lets escape, so one bad run never stops the
      // tick or the other triggers.
      logger.error(
        { capability: ctx.capabilityId, reason: ctx.reason, err: String(err) },
        "scheduled fire failed",
      );
    }
  }

  /**
   * Boot-time pass (§11). Arms first-seen triggers, and for any whose slot is
   * already in the past — meaning it came due while the daemon was down — applies
   * the manifest's `catch_up` policy exactly once before arming the next slot.
   *
   * Must run before the first tick: a tick treats a past slot as due-now and
   * always fires it, which is the right thing while running but would ignore
   * `catch_up: skip` at boot.
   */
  async reconcile(at: Date = this.#now()): Promise<void> {
    for (const trigger of this.#load()) {
      try {
        const schedule = this.#compile(trigger.cron);

        if (trigger.nextFireAt === null) {
          // Never armed: this is the first time the scheduler has seen it. Arm
          // the next occurrence; do not fire, or every new scheduled capability
          // would run the moment it is registered.
          this.#arm(trigger.capabilityId, nextFireAfter(schedule, at));
          continue;
        }

        if (Date.parse(trigger.nextFireAt) > at.getTime()) continue; // still ahead; nothing missed

        const scheduledFor = trigger.nextFireAt;
        this.#arm(trigger.capabilityId, nextFireAfter(schedule, at));

        if (trigger.enabled && trigger.catchUp === "run_once") {
          logger.info(
            { capability: trigger.capabilityId, scheduledFor },
            "replaying a scheduled run missed while down",
          );
          await this.#safeFire({
            capabilityId: trigger.capabilityId,
            cron: trigger.cron,
            scheduledFor,
            reason: "catch_up",
          });
        } else {
          // §11: a missed trigger with no run_once opt-in is recorded and skipped.
          logger.warn(
            { capability: trigger.capabilityId, scheduledFor, catch_up: trigger.catchUp },
            "missed_trigger",
          );
        }
      } catch (err) {
        logger.error(
          { capability: trigger.capabilityId, err: String(err) },
          "could not reconcile trigger",
        );
      }
    }
  }

  /**
   * One scheduling pass. Fires every owned trigger whose slot is due, advancing
   * its `next_fire_at` first (see the claim-before-firing note above).
   */
  async tick(at: Date = this.#now()): Promise<void> {
    for (const trigger of this.#load()) {
      try {
        const schedule = this.#compile(trigger.cron);

        if (trigger.nextFireAt === null) {
          this.#arm(trigger.capabilityId, nextFireAfter(schedule, at));
          continue;
        }

        if (Date.parse(trigger.nextFireAt) > at.getTime()) continue; // not yet due

        const scheduledFor = trigger.nextFireAt;
        // Claim the slot before doing any awaiting work.
        this.#arm(trigger.capabilityId, nextFireAfter(schedule, at));

        // A disabled capability is armed forward but not run, so re-enabling it
        // later does not trigger a catch-up for every slot it slept through.
        if (!trigger.enabled) continue;

        await this.#safeFire({
          capabilityId: trigger.capabilityId,
          cron: trigger.cron,
          scheduledFor,
          reason: "scheduled",
        });
      } catch (err) {
        logger.error(
          { capability: trigger.capabilityId, err: String(err) },
          "could not evaluate trigger",
        );
      }
    }
  }

  /**
   * Reconciles once, then ticks on an interval. `unref()` keeps the timer from
   * holding the process open on its own (the API server's listen socket does
   * that), and the tick guard drops a tick that arrives while the previous one
   * is still awaiting a slow run rather than letting them pile up.
   */
  async start(): Promise<void> {
    await this.reconcile();

    this.#timer = setInterval(() => {
      if (this.#ticking) return;
      this.#ticking = true;
      void this.tick().finally(() => {
        this.#ticking = false;
      });
    }, this.#intervalMs);
    this.#timer.unref();

    logger.info({ intervalMs: this.#intervalMs }, "scheduler started");
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * The upcoming fire time for each owned trigger, for the Dashboard. Reads the
   * persisted `next_fire_at` rather than recomputing, so what it shows is exactly
   * what will fire.
   */
  upcoming(): { capability_id: string; cron: string; next_fire_at: string | null }[] {
    return this.#load().map((t) => ({
      capability_id: t.capabilityId,
      cron: t.cron,
      next_fire_at: t.nextFireAt,
    }));
  }
}

/** Pulls `trigger.catch_up` out of a stored manifest, defaulting to `skip`. */
function catchUpOf(manifestJson: string): CatchUpMode {
  try {
    const manifest = JSON.parse(manifestJson) as Partial<CapabilityManifest>;
    const mode = manifest.trigger?.catch_up;
    return mode === "run_once" ? "run_once" : "skip";
  } catch {
    return "skip";
  }
}
