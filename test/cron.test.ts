import { describe, expect, it } from "vitest";
import { isValidCron, matches, nextFireAfter, parseCron } from "../src/scheduler/cron.js";

/** Local-time constructor so every assertion round-trips through the host TZ. */
function at(y: number, month1: number, day: number, hour = 0, min = 0): Date {
  return new Date(y, month1 - 1, day, hour, min, 0, 0);
}

describe("parseCron", () => {
  it("expands the wildcards", () => {
    const s = parseCron("* * * * *");
    expect(s.minutes.size).toBe(60);
    expect(s.hours.size).toBe(24);
    expect(s.daysOfMonth.size).toBe(31);
    expect(s.months.size).toBe(12);
    expect(s.daysOfWeek.size).toBe(7);
    expect(s.domRestricted).toBe(false);
    expect(s.dowRestricted).toBe(false);
  });

  it("parses the two real manifest crons", () => {
    const daily = parseCron("0 8 * * *");
    expect([...daily.minutes]).toEqual([0]);
    expect([...daily.hours]).toEqual([8]);

    const weekly = parseCron("0 20 * * 0");
    expect([...weekly.hours]).toEqual([20]);
    expect([...weekly.daysOfWeek]).toEqual([0]);
    expect(weekly.dowRestricted).toBe(true);
    expect(weekly.domRestricted).toBe(false);
  });

  it("handles steps, ranges and lists", () => {
    expect([...parseCron("*/15 * * * *").minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("0 9-17 * * *").hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parseCron("0,30 * * * *").minutes]).toEqual([0, 30]);
    expect([...parseCron("0 0 1-20/5 * *").daysOfMonth]).toEqual([1, 6, 11, 16]);
    expect([...parseCron("0 0 * * 1-5").daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it("normalises day-of-week 7 to 0 (both are Sunday)", () => {
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
    // 0-7 collapses to the full week with Sunday counted once.
    expect([...parseCron("0 0 * * 0-7").daysOfWeek].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it("rejects the malformed", () => {
    expect(() => parseCron("0 8 * *")).toThrow(/exactly 5 fields/);
    expect(() => parseCron("0 8 * * * *")).toThrow(/exactly 5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/minute: value out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/hour: value out of range/);
    expect(() => parseCron("* * 0 * *")).toThrow(/day-of-month: value out of range/);
    expect(() => parseCron("* * * 13 *")).toThrow(/month: value out of range/);
    expect(() => parseCron("* * * * 8")).toThrow(/day-of-week: value out of range/);
    expect(() => parseCron("5-1 * * * *")).toThrow(/start 5 is after end 1/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step must be a positive integer/);
    expect(() => parseCron("a * * * *")).toThrow(/non-integer/);
    expect(() => parseCron("0,,5 * * * *")).toThrow(/empty term/);
  });
});

describe("isValidCron", () => {
  it("is true for a good expression and false for a bad one", () => {
    expect(isValidCron("0 20 * * 0")).toBe(true);
    expect(isValidCron("0 8 * *")).toBe(false);
    expect(isValidCron("nonsense")).toBe(false);
  });
});

describe("matches", () => {
  it("fires only on the declared minute and hour", () => {
    const s = parseCron("0 8 * * *");
    expect(matches(s, at(2026, 7, 21, 8, 0))).toBe(true);
    expect(matches(s, at(2026, 7, 21, 8, 1))).toBe(false);
    expect(matches(s, at(2026, 7, 21, 9, 0))).toBe(false);
  });

  it("respects day-of-week", () => {
    const s = parseCron("0 20 * * 0"); // Sundays at 20:00
    expect(matches(s, at(2026, 7, 19, 20, 0))).toBe(true); // 2026-07-19 is a Sunday
    expect(matches(s, at(2026, 7, 21, 20, 0))).toBe(false); // Tuesday
  });

  it("applies the day-of-month / day-of-week OR rule when both are restricted", () => {
    const s = parseCron("0 0 1 * 1"); // the 1st, OR any Monday
    expect(matches(s, at(2026, 7, 1, 0, 0))).toBe(true); // the 1st (a Wednesday)
    expect(matches(s, at(2026, 7, 20, 0, 0))).toBe(true); // 2026-07-20 is a Monday
    expect(matches(s, at(2026, 7, 21, 0, 0))).toBe(false); // Tuesday, not the 1st
  });

  it("consults only the restricted half when the other is a wildcard", () => {
    expect(matches(parseCron("0 0 15 * *"), at(2026, 7, 15))).toBe(true);
    expect(matches(parseCron("0 0 15 * *"), at(2026, 7, 16))).toBe(false);
    expect(matches(parseCron("0 0 * * 5"), at(2026, 7, 21))).toBe(false); // Tuesday
    expect(matches(parseCron("0 0 * * 5"), at(2026, 7, 24))).toBe(true); // Friday
  });
});

describe("nextFireAfter", () => {
  it("returns today's slot when it is still ahead, tomorrow's once it has passed", () => {
    const s = parseCron("0 8 * * *");
    expect(nextFireAfter(s, at(2026, 7, 21, 7, 59)).getTime()).toBe(at(2026, 7, 21, 8, 0).getTime());
    expect(nextFireAfter(s, at(2026, 7, 21, 8, 0)).getTime()).toBe(at(2026, 7, 22, 8, 0).getTime());
    expect(nextFireAfter(s, at(2026, 7, 21, 8, 1)).getTime()).toBe(at(2026, 7, 22, 8, 0).getTime());
  });

  it("is strictly after: a matching instant yields the next occurrence, not itself", () => {
    const s = parseCron("*/15 * * * *");
    expect(nextFireAfter(s, at(2026, 7, 21, 10, 0)).getTime()).toBe(at(2026, 7, 21, 10, 15).getTime());
    expect(nextFireAfter(s, at(2026, 7, 21, 10, 7)).getTime()).toBe(at(2026, 7, 21, 10, 15).getTime());
  });

  it("finds the next Sunday for the weekly digest", () => {
    const s = parseCron("0 20 * * 0");
    // From Tuesday 2026-07-21, the next Sunday is 2026-07-26.
    const next = nextFireAfter(s, at(2026, 7, 21, 12, 0));
    expect(next.getTime()).toBe(at(2026, 7, 26, 20, 0).getTime());
    expect(next.getDay()).toBe(0);
  });

  it("rolls across a month boundary", () => {
    // 31st at midnight, from mid-April (30 days) skips to May 31.
    const next = nextFireAfter(parseCron("0 0 31 * *"), at(2026, 4, 15));
    expect(next.getTime()).toBe(at(2026, 5, 31, 0, 0).getTime());
  });

  it("rolls across a year boundary", () => {
    const next = nextFireAfter(parseCron("0 0 1 1 *"), at(2026, 7, 21));
    expect(next.getTime()).toBe(at(2027, 1, 1, 0, 0).getTime());
  });

  it("finds the next leap day", () => {
    // 2027 is not a leap year; the next Feb 29 after 2026 is in 2028.
    const next = nextFireAfter(parseCron("0 0 29 2 *"), at(2026, 7, 21));
    expect(next.getFullYear()).toBe(2028);
    expect(next.getMonth()).toBe(1); // February
    expect(next.getDate()).toBe(29);
  });

  it("throws on an impossible date rather than scanning forever", () => {
    // Feb 30 never occurs.
    expect(() => nextFireAfter(parseCron("0 0 30 2 *"), at(2026, 1, 1))).toThrow(/no matching time/);
  });
});
