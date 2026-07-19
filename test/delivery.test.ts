import { describe, expect, it } from "vitest";
import {
  formatItem,
  isWithinQuietHours,
  parseQuietHours,
  quietHoursEnd,
  TelegramDelivery,
} from "../src/delivery/index.js";
import { createActionItem } from "../src/store/action-items.js";
import type { Db } from "../src/store/db.js";
import { testDraft, testStore } from "./helpers.js";

/** 2026-07-19 at the given local hour. */
const at = (hour: number, minute = 0) => new Date(2026, 6, 19, hour, minute, 0, 0);

describe("parseQuietHours", () => {
  it("parses a window", () => {
    expect(parseQuietHours("22:00-07:00")).toEqual({ startMinutes: 1320, endMinutes: 420 });
  });

  it("rejects nonsense", () => {
    expect(() => parseQuietHours("late")).toThrow(/quiet_hours/);
    expect(() => parseQuietHours("25:00-07:00")).toThrow(/quiet_hours/);
  });
});

describe("isWithinQuietHours", () => {
  const overnight = parseQuietHours("22:00-07:00");

  it("covers the evening and the early morning across midnight", () => {
    expect(isWithinQuietHours(at(23), overnight)).toBe(true);
    expect(isWithinQuietHours(at(2), overnight)).toBe(true);
    expect(isWithinQuietHours(at(6, 59), overnight)).toBe(true);
  });

  it("is open during the day", () => {
    expect(isWithinQuietHours(at(7), overnight)).toBe(false);
    expect(isWithinQuietHours(at(14), overnight)).toBe(false);
    expect(isWithinQuietHours(at(21, 59), overnight)).toBe(false);
  });

  it("handles a same-day window too", () => {
    const daytime = parseQuietHours("09:00-17:00");
    expect(isWithinQuietHours(at(12), daytime)).toBe(true);
    expect(isWithinQuietHours(at(8), daytime)).toBe(false);
    expect(isWithinQuietHours(at(18), daytime)).toBe(false);
  });
});

describe("quietHoursEnd", () => {
  const overnight = parseQuietHours("22:00-07:00");

  it("returns this morning's end when queued after midnight", () => {
    const end = quietHoursEnd(at(2), overnight);
    expect(end.getDate()).toBe(19);
    expect(end.getHours()).toBe(7);
  });

  it("returns tomorrow's end when queued before midnight", () => {
    const end = quietHoursEnd(at(23), overnight);
    expect(end.getDate()).toBe(20);
    expect(end.getHours()).toBe(7);
  });
});

describe("formatItem", () => {
  it("leads with what will happen and includes a deep link", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());
    const text = formatItem(item);

    expect(text).toContain("Creates a Decision row in Notion");
    expect(text).toContain("Confidence: 80%");
    expect(text).toContain(`/actions/${item.id}`);
  });
});

describe("TelegramDelivery", () => {
  function harness(now: () => Date) {
    const db: Db = testStore();
    const sent: { chatId: string; text: string }[] = [];
    const delivery = new TelegramDelivery({
      db,
      now,
      send: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    });
    return { db, sent, delivery };
  }

  const queued = (db: Db) =>
    db
      .prepare<{ delivered_at: string | null; deliver_after: string | null; last_error: string | null }>(
        "SELECT delivered_at, deliver_after, last_error FROM delivery_queue",
      )
      .all();

  it("does nothing when telegram is disabled, which is the default", async () => {
    const { db, sent, delivery } = harness(() => at(14));
    const item = createActionItem(db, testDraft());
    await delivery.notify(item);
    // No chat_id configured, so nothing is sent and nothing is queued.
    expect(sent).toEqual([]);
    expect(queued(db)).toEqual([]);
  });
});

describe("delivery_queue schema", () => {
  it("exists after migration and records a queued row", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());
    db.prepare(
      `INSERT INTO delivery_queue (id, action_item_id, channel, body, queued_at, deliver_after)
       VALUES (?, ?, 'telegram', ?, ?, ?)`,
    ).run("q1", item.id, "body", "2026-07-19T23:00:00Z", "2026-07-20T07:00:00Z");

    const row = db
      .prepare<{ attempts: number; delivered_at: string | null }>(
        "SELECT attempts, delivered_at FROM delivery_queue WHERE id = 'q1'",
      )
      .get();
    expect(row).toEqual({ attempts: 0, delivered_at: null });
  });
});
