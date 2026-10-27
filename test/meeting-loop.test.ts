/**
 * The first workflow end to end (PROPOSAL Phase 1): calendar sync, a brief
 * before each meeting, a nudge after it, notes into the Inbox, and filing to
 * TickTick that a restart cannot duplicate.
 *
 * Exit criteria this file walks: "Five real meetings, including one reschedule
 * and one with no notes, go through without duplicates; restart after approval
 * creates no duplicate task."
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer, retireMeetingCards } from "../src/api/server.js";
import { createApp, type App } from "../src/app.js";
import { loadConfig, repoRoot } from "../src/config/index.js";
import {
  CalendarPoller,
  SyncTokenExpired,
  type CalendarEventItem,
  type CalendarSource,
} from "../src/events/listeners/calendar-sync.js";
import { createTickTickAdapter } from "../src/execution/adapters/ticktick.js";
import { listActionItems } from "../src/store/action-items.js";
import { extractItemsFromNotes } from "../capabilities/meeting/index.js";

let app: App;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "samaritan-meet-"));
  app = createApp({
    dbPath: ":memory:",
    capabilitiesDir: join(repoRoot(), "capabilities"),
    // Briefs ask Recall for context; a fixed embedder keeps that offline.
    recall: {
      embedder: {
        model: "test-deterministic",
        dimensions: 384,
        embed: async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05)),
      },
    },
  });
});

afterEach(() => {
  app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = new Date("2026-11-02T09:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();

function meeting(id: string, startMin: number, lengthMin = 30, extra: Partial<CalendarEventItem> = {}): CalendarEventItem {
  return {
    id,
    status: "confirmed",
    summary: `Meeting ${id}`,
    start: { dateTime: iso(startMin) },
    end: { dateTime: iso(startMin + lengthMin) },
    attendees: [{ email: "me@example.com", self: true }, { email: "priya@example.com", displayName: "Priya" }],
    ...extra,
  };
}

/** A fake Google: a full sync returns `calendar`; a token poll returns whatever `changes` holds. */
function fakeGoogle(calendar: CalendarEventItem[]) {
  const state = { changes: [] as CalendarEventItem[], expireToken: false, calls: [] as string[] };
  let token = 0;
  const source: CalendarSource = async ({ syncToken, pageToken }) => {
    state.calls.push(`${syncToken ?? "full"}${pageToken ? `+${pageToken}` : ""}`);
    if (syncToken && state.expireToken) {
      state.expireToken = false;
      throw new SyncTokenExpired("410");
    }
    if (!syncToken) {
      // Two pages, so pagination has to work for anything to be seen.
      const half = Math.ceil(calendar.length / 2);
      if (!pageToken) return { items: calendar.slice(0, half), nextPageToken: "p2" };
      return { items: calendar.slice(half), nextSyncToken: `tok-${++token}` };
    }
    const items = state.changes;
    state.changes = [];
    return { items, nextSyncToken: `tok-${++token}` };
  };
  return { source, state };
}

function poller(source: CalendarSource, now: () => Date) {
  return new CalendarPoller({
    db: app.db,
    source,
    now,
    prepLeadMinutes: 15,
    publish: (event) => app.eventBus.publish(event),
    onRetired: (id, reason) => retireMeetingCards(app, id, reason),
  });
}

const briefs = () => listActionItems(app.db, { capability_id: "meeting-prep", limit: 100 });
const nudges = () => listActionItems(app.db, { capability_id: "meeting-followup", limit: 100 });

describe("calendar sync", () => {
  it("briefs a meeting that did not change, reading every page and surviving a 410", async () => {
    const google = fakeGoogle([meeting("a", 60), meeting("b", 120), meeting("c", 180)]);
    let now = T0;
    const p = poller(google.source, () => now);

    expect((await p.pollOnce()).synced).toBe(3);
    expect(google.state.calls).toEqual(["full", "full+p2"]);
    expect(briefs()).toHaveLength(0);

    // An hour later Google reports no changes, but "a" now starts in 10 minutes.
    now = at(50);
    expect((await p.pollOnce()).upcomingPublished).toBe(1);
    expect(briefs().map((b) => b.custom["event_id"])).toEqual(["a"]);

    google.state.expireToken = true;
    now = at(51);
    await p.pollOnce();
    expect(google.state.calls.slice(-3)).toEqual(["tok-2", "full", "full+p2"]);
    expect(briefs()).toHaveLength(1); // still one brief: the bus remembers it fired
  });

  it("never briefs an all-day entry, a declined invitation or a solo block", async () => {
    const google = fakeGoogle([
      { id: "allday", summary: "Holiday", start: { date: "2026-11-02" }, end: { date: "2026-11-03" } },
      meeting("declined", 10, 30, {
        attendees: [{ email: "me@example.com", self: true, responseStatus: "declined" }, { email: "x@example.com" }],
      }),
      meeting("solo", 10, 30, { attendees: [] }),
    ]);
    await poller(google.source, () => T0).pollOnce();
    expect(briefs()).toHaveLength(0);
  });
});

describe("the first workflow, five meetings", () => {
  it("goes through a reschedule and a no-notes meeting without duplicates", async () => {
    const calendar = [meeting("m1", 10), meeting("m2", 70), meeting("m3", 130), meeting("m4", 190), meeting("m5", 250)];
    const google = fakeGoogle(calendar);
    let now = T0;
    const p = poller(google.source, () => now);
    const server = buildServer(app);

    try {
      // Walk the day in 5-minute steps, polling twice each step to prove repeats are harmless.
      for (let minute = 0; minute <= 330; minute += 5) {
        now = at(minute);
        if (minute === 60) {
          // m3 moves from 11:10 to 12:40, after its brief window has not yet opened.
          google.state.changes = [meeting("m3", 220)];
        }
        if (minute === 120) {
          // m3 moves again into the next 15 minutes: it gets a brief for its new time.
          google.state.changes = [meeting("m3", 130)];
        }
        await p.pollOnce();
        await p.pollOnce();

        // Notes go in as each meeting ends, except m4, which had none.
        for (const m of ["m1", "m2", "m3", "m5"]) {
          const ended = nudges().find((n) => n.custom["event_id"] === m && n.status === "pending");
          if (!ended) continue;
          const res = await server.inject({
            method: "POST",
            url: "/api/meetings/notes",
            payload: { event_id: m, notes: `Decision: ship ${m}\nAction: follow up on ${m}` },
          });
          expect(res.statusCode).toBe(202);
        }
        const m4 = nudges().find((n) => n.custom["event_id"] === "m4" && n.status === "pending");
        if (m4) await app.actionCenter.respond(m4.id, { response_id: "no_notes", actor: "sandip" });
      }

      // One brief per meeting, one nudge per meeting, all settled.
      const briefIds = briefs().map((b) => b.custom["event_id"]).sort();
      expect(briefIds).toEqual(["m1", "m2", "m3", "m4", "m5"]);
      expect(nudges().map((n) => n.custom["event_id"]).sort()).toEqual(["m1", "m2", "m3", "m4", "m5"]);
      expect(nudges().every((n) => n.status === "rejected")).toBe(true);

      // Two reviewable items from each meeting that had notes, none from m4.
      const items = listActionItems(app.db, { capability_id: "meeting", limit: 100 });
      expect(items).toHaveLength(8);
      expect(new Set(items.map((i) => i.dedupe_key)).size).toBe(8);
      expect(items.some((i) => i.dedupe_key.includes("m4"))).toBe(false);
      expect(items.every((i) => i.custom["meeting_topic"] !== "Meeting Notes")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("retires a pending brief when the meeting is cancelled", async () => {
    const google = fakeGoogle([meeting("x", 10)]);
    const p = poller(google.source, () => T0);
    await p.pollOnce();
    expect(briefs()[0]?.status).toBe("pending");
    google.state.changes = [{ id: "x", status: "cancelled" }];
    await p.pollOnce();
    expect(briefs()[0]?.status).toBe("expired");
  });
});

describe("meeting notes", () => {
  it("reads keywords only with their colon", () => {
    const items = extractItemsFromNotes(
      ["Taskforce update went well", "Actionable feedback from Rohan", "Todo: book the room", "- [ ] send deck"].join("\n"),
    );
    expect(items.map((i) => i.title)).toEqual(["book the room", "send deck"]);
  });

  it("never overwrites a meeting note that already exists", async () => {
    const vault = loadConfig().paths.vault;
    const post = (notes: string) =>
      app.actionCenter && buildServer(app).inject({
        method: "POST",
        url: "/api/meetings/notes",
        payload: { title: "Overwrite check", date: "2026-11-02", notes },
      });
    await post("Decision: first paste");
    await post("Decision: second paste");
    const first = join(vault, "Areas", "Meetings", "2026-11-02 - Overwrite check.md");
    const second = join(vault, "Areas", "Meetings", "2026-11-02 - Overwrite check (2).md");
    expect(readFileSync(first, "utf8")).toContain("first paste");
    expect(existsSync(second) && readFileSync(second, "utf8")).toContain("second paste");
  });
});

describe("filing to TickTick after a restart", () => {
  const request = (key: string) => ({
    action_item_id: "00000000-0000-4000-8000-000000000001",
    capability: "ticktick.task.create" as const,
    mode: "automated" as const,
    idempotency_key: key,
    payload: { title: "Send the checklist", due: "2026-11-05" },
  });

  it("finds the task an interrupted attempt created instead of posting a second one", async () => {
    let posts = 0;
    let createdContent = "";
    const crashing = createTickTickAdapter({
      db: app.db,
      token: () => "t",
      fetchImpl: async (_url, init) => {
        posts++;
        createdContent = JSON.parse(String(init?.body)).content;
        expect(JSON.parse(String(init?.body)).dueDate).toBe("2026-11-05T00:00:00+0000");
        throw new Error("socket hang up"); // TickTick committed; the reply never arrived
      },
    });
    expect((await crashing.execute(request("item-1:attempt"))).status).toBe("failed");

    const afterRestart = createTickTickAdapter({
      db: app.db,
      token: () => "t",
      fetchImpl: async (url, init) => {
        expect(init?.method ?? "GET").toBe("GET");
        expect(String(url)).toMatch(/\/project\/inbox\/data$/);
        return Response.json({ tasks: [{ id: "tt-1", content: createdContent }] });
      },
    });
    const outcome = await afterRestart.execute(request("item-1:attempt"));
    expect(outcome).toMatchObject({ status: "succeeded", result: { ticktick_task_id: "tt-1" } });
    expect(posts).toBe(1);
  });

  it("refuses to post again when it cannot check", async () => {
    const first = createTickTickAdapter({
      db: app.db,
      token: () => "t",
      fetchImpl: async () => {
        throw new Error("timeout");
      },
    });
    await first.execute(request("item-2:attempt"));
    let posted = false;
    const second = createTickTickAdapter({
      db: app.db,
      token: () => "t",
      fetchImpl: async (_url, init) => {
        if (init?.method === "POST") posted = true;
        return new Response("down", { status: 503 });
      },
    });
    const outcome = await second.execute(request("item-2:attempt"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/may already have created/);
    expect(posted).toBe(false);
  });
});
