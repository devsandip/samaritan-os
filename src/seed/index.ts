/**
 * Demo seeding.
 *
 * Runs every capability that ships a `fixtures/demo.json` against that fixture,
 * through the real Run Layer and the real Action Center. Nothing here writes to
 * `action_items` directly.
 *
 * That constraint is the point rather than an implementation detail. The first
 * thing anyone clicks in a demo of a review gate is the audit trail, and a
 * hand-written row would have a fabricated one: no real policy decision, no
 * real matched rule, no real provenance. Going through ingest means every
 * seeded item is indistinguishable from a real one because it is one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.js";
import { runCapability, type RunReport } from "../run-layer/index.js";
import { listActionItems, transition } from "../store/action-items.js";
import { UNSETTLED_STATUSES, type ActionItem } from "../types/index.js";

export interface Seedable {
  id: string;
  name: string;
  fixturePath: string;
  /** The fixture's `_comment`, which says what it is meant to demonstrate. */
  note?: string;
}

/**
 * Capabilities that can be seeded: registered, and shipping a demo fixture.
 *
 * Discovered, never listed. Adding an agent to the demo has to be the same
 * gesture as adding one at all — drop a folder in — or the seed becomes a
 * second registry that drifts from the first.
 */
export function seedable(app: App, only: string[] = []): Seedable[] {
  return app.capabilities
    .all()
    .map((capability) => {
      const fixturePath = join(capability.dir, "fixtures", "demo.json");
      if (!existsSync(fixturePath)) return undefined;
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { _comment?: string };
      return {
        id: capability.manifest.id,
        name: capability.manifest.name,
        fixturePath,
        ...(fixture._comment ? { note: fixture._comment } : {}),
      };
    })
    .filter((entry): entry is Seedable => Boolean(entry))
    .filter((entry) => !only.length || only.includes(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Resolves everything a previous seed left open, preserving the trail.
 *
 * Not a delete. `action_item_events` is append-only and a trigger enforces it
 * (§9), and action items are referenced by it, so "undo the demo" cannot mean
 * erasing the history and should not: the system's own answer to an item you
 * no longer want is to dismiss it, which is what this does.
 */
export function clearSeeded(app: App, ids: string[]): { cleared: number; skipped: string[] } {
  let cleared = 0;
  const skipped: string[] = [];

  for (const id of ids) {
    const open = listActionItems(app.db, {
      capability_id: id,
      status: [...UNSETTLED_STATUSES],
      limit: 500,
    });
    for (const item of open) {
      try {
        transition(app.db, {
          id: item.id,
          to: "rejected",
          actor: "sandip",
          reason: "cleared by samaritan seed --clear",
        });
        cleared++;
      } catch (err) {
        // An item mid-handoff refuses this, which is correct: it is waiting on
        // a confirmation the OS cannot give itself. Not worth failing over.
        skipped.push(`${item.id}: ${(err as Error).message}`);
      }
    }
  }
  return { cleared, skipped };
}

/**
 * Answers a few items the way Sandip would, so the other views are not empty.
 *
 * Deferred, Completed and the mid-flight confirm loop are empty in a freshly
 * seeded store, and three empty views make a working system look broken. These
 * responses go through the Action Center, so their audit trails are real.
 *
 * The hard rule: nothing here touches the outside world. It only defers,
 * dismisses, or approves an item whose effective mode is `guided`, which stages
 * a payload and stops. An automated item would file to Notion or TickTick, and
 * a seed script is not entitled to make that call on Sandip's behalf. That is
 * the entire point of the thing being demoed.
 */
export async function act(app: App, ids: string[]): Promise<string[]> {
  const done: string[] = [];
  const pending = ids
    .flatMap((id) => listActionItems(app.db, { capability_id: id, status: "pending", limit: 100 }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const used = new Set<string>();
  const responseWith = (item: ActionItem, outcome: string): string | undefined =>
    app.capabilities
      .getType(item.capability_id, item.type)
      ?.spec.responses.find((r) => r.outcome === outcome)?.id;

  const steps: { outcome: string; label: string; extra?: (item: ActionItem) => boolean }[] = [
    { outcome: "defer", label: "deferred" },
    // Guided only. This is the one that lands in awaiting_confirmation, the
    // state the demo most needs to be able to point at.
    { outcome: "execute", label: "staged", extra: (item) => item.execution.mode === "guided" },
    { outcome: "discard", label: "dismissed" },
  ];

  for (const step of steps) {
    const item = pending.find(
      (candidate) =>
        !used.has(candidate.id) &&
        Boolean(responseWith(candidate, step.outcome)) &&
        (step.extra ? step.extra(candidate) : true),
    );
    if (!item) continue;

    used.add(item.id);
    await app.actionCenter.respond(item.id, {
      response_id: responseWith(item, step.outcome)!,
      actor: "sandip",
    });
    done.push(`${step.label.padEnd(12)}${item.capability_id}: ${item.type}`);
  }

  return done;
}

export interface SeedOptions {
  only?: string[];
  clear?: boolean;
  act?: boolean;
  /** Re-run a capability that has already been seeded. See `alreadySeeded`. */
  force?: boolean;
}

/**
 * Whether this capability has produced anything in this store before.
 *
 * Re-seeding is not idempotent on its own, and the reason is correct behaviour
 * elsewhere: re-emitting a *settled* item forks a fresh row (§5.1 branch 3),
 * because a logical event that already ran its course and then happens again is
 * a new event. True for a real capability. False for a seed, which is replaying
 * the same fixture rather than observing the world twice.
 *
 * Left alone, a second `samaritan seed` appends the weekly digest to the vault
 * again and files a second copy of the daily note. So a capability that has
 * already been seeded is skipped, and `--force` is how you say you meant it.
 */
function alreadySeeded(app: App, capabilityId: string): boolean {
  const row = app.db
    .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM action_items WHERE capability_id = ?")
    .get(capabilityId);
  return (row?.n ?? 0) > 0;
}

export interface RunReportEntry {
  target: Seedable;
  report: RunReport;
}

export interface SeedResult {
  reports: RunReportEntry[];
  /** Capability ids skipped because they had already been seeded. */
  skipped: string[];
  cleared: number;
  acted: string[];
  /** Everything unsettled and not snoozed, i.e. what the Inbox will show. */
  inboxCount: number;
  failures: number;
}

export async function runSeed(app: App, options: SeedOptions = {}): Promise<SeedResult> {
  const targets = seedable(app, options.only ?? []);
  const ids = targets.map((t) => t.id);

  const cleared = options.clear ? clearSeeded(app, ids).cleared : 0;

  const reports: SeedResult["reports"] = [];
  const skipped: string[] = [];
  let failures = 0;
  for (const target of targets) {
    if (!options.force && alreadySeeded(app, target.id)) {
      skipped.push(target.id);
      continue;
    }
    const inputs = JSON.parse(readFileSync(target.fixturePath, "utf8")) as Record<string, unknown>;
    const report = await runCapability(app, target.id, { inputs });
    if (report.status !== "ok" || report.rejected.length) failures++;
    reports.push({ target, report });
  }

  // Only when something was actually seeded. Otherwise a second `samaritan
  // seed`, which seeds nothing, would still answer three more items and eat
  // the Inbox it was asked to fill.
  const acted = options.act === false || !reports.length ? [] : await act(app, ids);

  const inboxCount = listActionItems(app.db, { status: [...UNSETTLED_STATUSES], limit: 500 }).filter(
    (item) => item.status !== "deferred",
  ).length;

  return { reports, skipped, cleared, acted, inboxCount, failures };
}
