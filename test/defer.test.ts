/**
 * Defer and resurface (UI-SPEC §5.3).
 *
 * Deferred used to be a one-way door: the status existed, but nothing recorded
 * when the item should come back and nothing swept it, so "Later" meant "discard
 * quietly." These tests pin the round trip — snooze, wake, act — and the two
 * in-place actions the Deferred view offers on a snoozed item.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_DEFER_FOR, deferUntil } from "../src/action-center/index.js";
import { repoRoot } from "../src/config/index.js";
import {
  canTransition,
  createActionItem,
  getActionItem,
  listActionItems,
  listAuditTrail,
  transition,
} from "../src/store/action-items.js";
import { harness, testDraft, testStore, wrapItem } from "./helpers.js";

/** 2026-07-19 at the given local hour. Quiet hours are local-time arithmetic. */
const at = (hour: number, minute = 0) => new Date(2026, 6, 19, hour, minute, 0, 0);

const OVERNIGHT = "22:00-07:00";

describe("deferUntil", () => {
  it("defaults to a day when the manifest does not say", () => {
    const from = at(10);
    const until = new Date(deferUntil(undefined, undefined, from));
    expect(until.getTime() - from.getTime()).toBe(24 * 3_600_000);
    expect(DEFAULT_DEFER_FOR).toBe("1d");
  });

  it("honours the response's declared window", () => {
    const from = at(10);
    const until = new Date(deferUntil("4h", undefined, from));
    expect(until.getTime() - from.getTime()).toBe(4 * 3_600_000);
  });

  it("leaves a daytime resurface alone", () => {
    const until = new Date(deferUntil("4h", OVERNIGHT, at(10)));
    expect(until.getHours()).toBe(14);
    expect(until.getDate()).toBe(19);
  });

  it("pushes a resurface that lands inside quiet hours to the moment it opens", () => {
    // 23:00 + 3h = 02:00, inside 22:00-07:00, so it waits for 07:00.
    const until = new Date(deferUntil("3h", OVERNIGHT, at(23)));
    expect(until.getHours()).toBe(7);
    expect(until.getMinutes()).toBe(0);
    expect(until.getDate()).toBe(20);
  });

  it("does not adjust when no quiet window is configured", () => {
    const until = new Date(deferUntil("3h", undefined, at(23)));
    expect(until.getHours()).toBe(2);
    expect(until.getDate()).toBe(20);
  });

  it("rejects a malformed window rather than snoozing forever", () => {
    expect(() => deferUntil("soon", undefined, at(10))).toThrow(/invalid duration/);
  });
});

describe("the deferred status", () => {
  it("allows acting in place: approve now, or drop", () => {
    // UI-SPEC §5.3 puts "Act now" and "Drop" on every deferred row. Both were
    // illegal transitions, so both 409'd.
    expect(canTransition("deferred", "approved")).toBe(true);
    expect(canTransition("deferred", "rejected")).toBe(true);
  });

  it("still allows the scheduled wake and the ttl sweep", () => {
    expect(canTransition("deferred", "pending")).toBe(true);
    expect(canTransition("deferred", "expired")).toBe(true);
  });

  it("round-trips defer_until through the store", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());
    const until = at(12).toISOString();

    const deferred = transition(db, {
      id: item.id,
      to: "deferred",
      actor: "sandip",
      patch: { defer_until: until },
    });

    expect(deferred.defer_until).toBe(until);
    expect(getActionItem(db, item.id)?.defer_until).toBe(until);
  });

  it("clears defer_until on the way out, so a woken item shows no resurface time", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());
    transition(db, {
      id: item.id,
      to: "deferred",
      actor: "sandip",
      patch: { defer_until: at(12).toISOString() },
    });

    const woken = transition(db, { id: item.id, to: "pending", actor: "system" });
    expect(woken.defer_until).toBeNull();
  });

  it("defaults to null for an item that was never deferred", () => {
    const db = testStore();
    expect(createActionItem(db, testDraft()).defer_until).toBeNull();
  });
});

describe("responding with defer", () => {
  it("records when the item comes back, from the manifest's defer_for", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const before = Date.now();

    const deferred = await h.actionCenter.respond(accepted[0]!.id, { response_id: "defer" });

    expect(deferred.status).toBe("deferred");
    expect(deferred.defer_until).not.toBeNull();
    // capabilities/wrap/manifest.yaml declares defer_for: 1d.
    const delta = Date.parse(deferred.defer_until!) - before;
    expect(delta).toBeGreaterThan(23 * 3_600_000);
    expect(delta).toBeLessThanOrEqual(25 * 3_600_000);
  });

  it("respects the configured quiet window", async () => {
    const h = harness({ quietHours: "00:00-23:59" });
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);

    const deferred = await h.actionCenter.respond(accepted[0]!.id, { response_id: "defer" });

    // The window swallows the whole day, so the resurface can only be its end.
    expect(new Date(deferred.defer_until!).getHours()).toBe(23);
    expect(new Date(deferred.defer_until!).getMinutes()).toBe(59);
  });

  it("files nothing while the item sits deferred", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    await h.actionCenter.respond(accepted[0]!.id, { response_id: "defer" });

    expect(h.notionDecision.calls).toHaveLength(0);
  });
});

describe("acting on an already-deferred item", () => {
  it("approves and executes without waiting for the window", async () => {
    // The reported dead end: "Act now" on a deferred item 409'd on every
    // response because deferred -> approved was illegal.
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    await h.actionCenter.respond(accepted[0]!.id, { response_id: "defer" });

    const acted = await h.actionCenter.respond(accepted[0]!.id, { response_id: "approve" });

    expect(acted.status).toBe("executed");
    expect(h.notionDecision.calls).toHaveLength(1);
  });

  it("drops without executing", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    await h.actionCenter.respond(accepted[0]!.id, { response_id: "defer" });

    const dropped = await h.actionCenter.respond(accepted[0]!.id, { response_id: "reject" });

    expect(dropped.status).toBe("rejected");
    expect(dropped.defer_until).toBeNull();
    expect(h.notionDecision.calls).toHaveLength(0);
  });
});

describe("resurface", () => {
  it("returns a due item to the inbox and clears its resurface time", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;
    await h.actionCenter.respond(id, { response_id: "defer" });

    const woke = await h.actionCenter.resurface(new Date(Date.now() + 25 * 3_600_000));

    expect(woke).toBe(1);
    const item = getActionItem(h.db, id)!;
    expect(item.status).toBe("pending");
    expect(item.defer_until).toBeNull();
  });

  it("leaves an item whose window has not elapsed alone", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    await h.actionCenter.respond(accepted[0]!.id, { response_id: "defer" });

    expect(await h.actionCenter.resurface(new Date(Date.now() + 3_600_000))).toBe(0);
    expect(getActionItem(h.db, accepted[0]!.id)?.status).toBe("deferred");
  });

  it("attributes the wake to the system in the audit trail", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;
    await h.actionCenter.respond(id, { response_id: "defer" });
    await h.actionCenter.resurface(new Date(Date.now() + 25 * 3_600_000));

    const last = listAuditTrail(h.db, id).at(-1)!;
    expect(last).toMatchObject({
      from_status: "deferred",
      to_status: "pending",
      actor: "system",
      reason: "defer window elapsed",
    });
  });

  it("re-notifies, so a snooze to morning actually surfaces in the morning", async () => {
    const notify = vi.fn(async () => {});
    const h = harness({ delivery: { notify } });
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    notify.mockClear(); // ignore the escalation notification

    await h.actionCenter.respond(accepted[0]!.id, { response_id: "defer" });
    await h.actionCenter.resurface(new Date(Date.now() + 25 * 3_600_000));

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("survives a delivery failure, because the wake is already committed", async () => {
    const notify = vi.fn(async () => {
      throw new Error("telegram is down");
    });
    const h = harness({ delivery: { notify } });
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);

    await h.actionCenter.respond(accepted[0]!.id, { response_id: "defer" });
    await expect(
      h.actionCenter.resurface(new Date(Date.now() + 25 * 3_600_000)),
    ).resolves.toBe(1);
    expect(getActionItem(h.db, accepted[0]!.id)?.status).toBe("pending");
  });

  it("ignores items that are not deferred", async () => {
    const h = harness();
    await h.actionCenter.ingest("wrap", [wrapItem()]);

    expect(await h.actionCenter.resurface(new Date(Date.now() + 400 * 3_600_000))).toBe(0);
  });

  it("does not resurrect an item the ttl sweep already expired", async () => {
    // expire() covers deferred rows too. Running it first must win: an item past
    // both its ttl and its snooze is expired, not back in the inbox.
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;
    await h.actionCenter.respond(id, { response_id: "defer" });

    // wrap declares ttl: null, so the row has no expiry of its own. Give it one
    // to put the two sweeps in contention at all.
    transition(h.db, {
      id,
      to: "deferred",
      actor: "system",
      patch: { expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    });
    const wayLater = new Date(Date.now() + 400 * 3_600_000);

    h.actionCenter.expire(wayLater);
    expect(await h.actionCenter.resurface(wayLater)).toBe(0);
    expect(getActionItem(h.db, id)?.status).toBe("expired");
  });

  it("wakes several items oldest-window-first", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [
      wrapItem({ dedupe_key: "wrap:a" }),
      wrapItem({ dedupe_key: "wrap:b" }),
    ]);
    for (const a of accepted) await h.actionCenter.respond(a.id, { response_id: "defer" });

    expect(await h.actionCenter.resurface(new Date(Date.now() + 25 * 3_600_000))).toBe(2);
    expect(listActionItems(h.db, { status: "pending" })).toHaveLength(2);
  });
});

/** The same logical item as `wrapItem()`, re-extracted with a sharper title. */
const revised = () =>
  wrapItem({
    custom: {
      kind: "decision",
      title: "Use node:sqlite; better-sqlite3 has no Node 26 binary",
      detail: "Confirmed against the 0.28 release notes",
      project: "Samaritan",
      owner: "sandip",
      due: "",
      evidence: "pnpm refused to run the build script",
    },
  });

const temps: string[] = [];

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

/**
 * A copy of the real capabilities folder with wrap's policy rewritten to escalate
 * while the item has no owner and auto-complete once it names one. Editing the
 * manifest the daemon actually loads keeps the fixture from drifting off-schema.
 */
function autoCompleteOnOwner(): string {
  const dir = mkdtempSync(join(tmpdir(), "samaritan-caps-"));
  temps.push(dir);
  cpSync(join(repoRoot(), "capabilities"), dir, { recursive: true });

  const path = join(dir, "wrap", "manifest.yaml");
  const manifest = parseYaml(readFileSync(path, "utf8")) as {
    emits: { policy: Record<string, string> }[];
  };
  manifest.emits[0]!.policy = {
    escalate_when: 'owner == ""',
    auto_complete_when: 'owner != ""',
  };
  writeFileSync(path, stringifyYaml(manifest));
  return dir;
}

/** Ingests one wrap item and snoozes it. Returns the row and the window it got. */
async function snoozed(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
  const id = accepted[0]!.id;
  const deferred = await h.actionCenter.respond(id, { response_id: "defer" });
  return { h, id, until: deferred.defer_until! };
}

describe("re-ingesting an item that is snoozed", () => {
  it("supersedes the snoozed row rather than forking a second one", async () => {
    const { h, id } = await snoozed();

    const { accepted, rejected } = await h.actionCenter.ingest("wrap", [revised()]);

    expect(rejected).toEqual([]);
    expect(accepted[0]!.id).toBe(id);
    expect(listActionItems(h.db, {})).toHaveLength(1);
  });

  it("keeps the item snoozed for exactly the window Sandip set", async () => {
    // The whole point of the branch. A re-ingest says what the content is now;
    // it says nothing about when Sandip wants to look at it.
    const { h, id, until } = await snoozed();

    await h.actionCenter.ingest("wrap", [revised()]);

    const item = getActionItem(h.db, id)!;
    expect(item.status).toBe("deferred");
    expect(item.defer_until).toBe(until);
  });

  it("refreshes the content, so the wake shows what is true now", async () => {
    const { h, id } = await snoozed();

    await h.actionCenter.ingest("wrap", [revised()]);

    const item = getActionItem(h.db, id)!;
    expect(item.custom).toMatchObject({
      title: "Use node:sqlite; better-sqlite3 has no Node 26 binary",
      owner: "sandip",
    });
    // The custom payload doubles as the execution payload, so both move together
    // or the item files stale content on approval.
    expect(item.execution.payload).toMatchObject({
      title: "Use node:sqlite; better-sqlite3 has no Node 26 binary",
    });
  });

  it("wakes once, not twice", async () => {
    // The reported duplicate, end to end: the old row used to survive the
    // re-ingest as an orphan with its defer_until intact, so the sweep woke it
    // alongside the fresh row and the Inbox showed the same thing twice.
    const { h } = await snoozed();
    await h.actionCenter.ingest("wrap", [revised()]);

    const woke = await h.actionCenter.resurface(new Date(Date.now() + 25 * 3_600_000));

    expect(woke).toBe(1);
    expect(listActionItems(h.db, { status: "pending" })).toHaveLength(1);
  });

  it("leaves no superseded key behind, which is the orphan's fingerprint", async () => {
    const { h } = await snoozed();

    await h.actionCenter.ingest("wrap", [revised()]);

    expect(listActionItems(h.db, {}).map((i) => i.dedupe_key)).toEqual(["wrap:sess-2026-07-19:0"]);
  });

  it("does not notify, because the snooze is still in force", async () => {
    // Pinging about an item Sandip explicitly snoozed would defeat the snooze
    // through the side door.
    const notify = vi.fn(async () => {});
    const { h } = await snoozed({ delivery: { notify } });
    notify.mockClear();

    await h.actionCenter.ingest("wrap", [revised()]);

    expect(notify).not.toHaveBeenCalled();
  });

  it("records the supersede in the audit trail", async () => {
    const { h, id } = await snoozed();

    await h.actionCenter.ingest("wrap", [revised()]);

    expect(listAuditTrail(h.db, id).at(-1)).toMatchObject({
      from_status: "deferred",
      to_status: "deferred",
      actor: "capability",
      reason: "superseded_by_reingest",
    });
  });

  it("still lets policy pull an urgent refresh through the snooze", async () => {
    // Holding the window is only safe because this way through exists. If the
    // refreshed content no longer needs a human, it files without waiting.
    const h = harness({ capabilitiesDir: autoCompleteOnOwner() });
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;
    expect(accepted[0]!.status).toBe("pending");
    await h.actionCenter.respond(id, { response_id: "defer" });

    const again = await h.actionCenter.ingest("wrap", [revised()]);

    expect(again.accepted[0]!.id).toBe(id);
    expect(again.accepted[0]!.policy.outcome).toBe("auto_complete");
    const item = getActionItem(h.db, id)!;
    expect(item.status).toBe("executed");
    expect(item.defer_until).toBeNull();
    expect(h.notionDecision.calls).toHaveLength(1);
  });

  it("still wakes on the original schedule after several re-ingests", async () => {
    // A capability that re-emits on every run must not be able to push the
    // window out indefinitely, which is the other way to lose a snooze.
    const { h, until } = await snoozed();

    for (let i = 0; i < 3; i++) await h.actionCenter.ingest("wrap", [revised()]);

    expect(listActionItems(h.db, {})).toHaveLength(1);
    expect(listActionItems(h.db, {})[0]!.defer_until).toBe(until);
  });
});

describe("re-ingesting an item that really did run its course", () => {
  // Guarding the other side of the line: moving deferred out of settled must not
  // drag the genuinely finished statuses with it.
  it("forks a fresh row for a rejected item", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;
    await h.actionCenter.respond(id, { response_id: "reject" });

    const again = await h.actionCenter.ingest("wrap", [revised()]);

    expect(again.accepted[0]!.id).not.toBe(id);
    expect(listActionItems(h.db, {})).toHaveLength(2);
    expect(getActionItem(h.db, id)?.status).toBe("rejected");
    expect(getActionItem(h.db, id)?.dedupe_key).toBe(`wrap:sess-2026-07-19:0:superseded:${id}`);
  });

  it("forks a fresh row for an executed item", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;
    await h.actionCenter.respond(id, { response_id: "approve" });
    expect(getActionItem(h.db, id)?.status).toBe("executed");

    const again = await h.actionCenter.ingest("wrap", [revised()]);

    expect(again.accepted[0]!.id).not.toBe(id);
    expect(listActionItems(h.db, {})).toHaveLength(2);
  });
});
