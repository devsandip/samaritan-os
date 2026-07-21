import { describe, expect, it } from "vitest";
import { matchesFilter } from "../src/events/filter.js";

describe("matchesFilter", () => {
  it("matches everything when there is no filter", () => {
    expect(matchesFilter(undefined, { from: "anyone@x.com" })).toBe(true);
    expect(matchesFilter({}, { from: "anyone@x.com" })).toBe(true);
  });

  describe("_in", () => {
    it("passes when the field is one of the listed values", () => {
      const filter = { from_in: ["@newsletters"] };
      expect(matchesFilter(filter, { from: "@newsletters" })).toBe(true);
      expect(matchesFilter(filter, { from: "boss@work.com" })).toBe(false);
    });

    it("intersects when the payload field is itself a list", () => {
      const filter = { labels_in: ["newsletter", "promotions"] };
      expect(matchesFilter(filter, { labels: ["inbox", "newsletter"] })).toBe(true);
      expect(matchesFilter(filter, { labels: ["inbox", "important"] })).toBe(false);
    });
  });

  describe("_contains", () => {
    it("checks substring for a string field", () => {
      expect(matchesFilter({ subject_contains: "invoice" }, { subject: "Your invoice #4" })).toBe(true);
      expect(matchesFilter({ subject_contains: "invoice" }, { subject: "Lunch?" })).toBe(false);
    });

    it("checks membership for a list field", () => {
      expect(matchesFilter({ tags_contains: "urgent" }, { tags: ["urgent", "sales"] })).toBe(true);
      expect(matchesFilter({ tags_contains: "urgent" }, { tags: ["sales"] })).toBe(false);
    });
  });

  describe("eq (plain key or _eq suffix)", () => {
    it("compares equality either way", () => {
      expect(matchesFilter({ kind: "newsletter" }, { kind: "newsletter" })).toBe(true);
      expect(matchesFilter({ kind_eq: "newsletter" }, { kind: "newsletter" })).toBe(true);
      expect(matchesFilter({ kind: "newsletter" }, { kind: "receipt" })).toBe(false);
    });
  });

  it("ANDs every term together", () => {
    const filter = { from_in: ["@newsletters"], subject_contains: "weekly" };
    expect(matchesFilter(filter, { from: "@newsletters", subject: "The weekly roundup" })).toBe(true);
    // First term passes, second fails.
    expect(matchesFilter(filter, { from: "@newsletters", subject: "One-off" })).toBe(false);
  });

  it("fails closed when the field is absent from the payload", () => {
    // The payload has no `from` at all — the filter cannot be satisfied, so it
    // must not fire rather than defaulting to a pass.
    expect(matchesFilter({ from_in: ["@newsletters"] }, { subject: "hi" })).toBe(false);
    expect(matchesFilter({ from_contains: "x" }, {})).toBe(false);
    expect(matchesFilter({ from: "x" }, {})).toBe(false);
  });
});
