/**
 * The pure core of the Fireflies transcript consumer (TECH-SPEC §2.2, §5.2).
 *
 * The webhook announces a transcript is ready; this is what a subscribing
 * capability does with the meeting id — build the query, normalise the response,
 * split Fireflies' own action items, and turn them into review items. None of it
 * touches a socket, so all of it is pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  firefliesTranscriptQuery,
  normalizeTranscript,
  parseActionItems,
  transcriptToDraftItems,
  type FirefliesTranscript,
} from "../src/events/listeners/fireflies-transcript.js";

describe("firefliesTranscriptQuery", () => {
  it("asks for one transcript by id, carrying the meeting id as the variable", () => {
    const { query, variables } = firefliesTranscriptQuery("ff-123");
    expect(query).toContain("transcript(id: $transcriptId)");
    expect(query).toContain("action_items");
    expect(query).toContain("overview");
    expect(variables).toEqual({ transcriptId: "ff-123" });
  });
});

describe("normalizeTranscript", () => {
  it("reads a full transcript through", () => {
    const t = normalizeTranscript(
      {
        id: "ff-9",
        title: "Roadmap sync",
        dateString: "2026-07-20T15:00:00.000Z",
        transcript_url: "https://app.fireflies.ai/view/ff-9",
        summary: { overview: "We aligned on Q3.", action_items: "- Ship it (01:00)" },
      },
      "ff-9",
    );
    expect(t).toEqual<FirefliesTranscript>({
      id: "ff-9",
      title: "Roadmap sync",
      date: "2026-07-20T15:00:00.000Z",
      url: "https://app.fireflies.ai/view/ff-9",
      overview: "We aligned on Q3.",
      actionItemsRaw: "- Ship it (01:00)",
    });
  });

  it("defaults missing fields and falls back to the meeting id for id and url", () => {
    const t = normalizeTranscript({ title: "", summary: null }, "ff-fallback");
    expect(t.id).toBe("ff-fallback");
    expect(t.title).toBe("Untitled meeting");
    expect(t.date).toBe("");
    expect(t.url).toBe("https://app.fireflies.ai/view/ff-fallback");
    expect(t.overview).toBe("");
    expect(t.actionItemsRaw).toBe("");
  });

  it("survives a null transcript (a meeting id Fireflies has no record of)", () => {
    const t = normalizeTranscript(null, "ff-null");
    expect(t.id).toBe("ff-null");
    expect(t.actionItemsRaw).toBe("");
  });
});

describe("parseActionItems", () => {
  it("carries a bold assignee heading onto the items below it", () => {
    const raw = ["**Sandip**", "- Send the PRD (12:34)", "- Book the room (23:45)", "**Jane Doe**", "Review the deck (34:56)"].join("\n");
    expect(parseActionItems(raw)).toEqual([
      { text: "Send the PRD", owner: "Sandip" },
      { text: "Book the room", owner: "Sandip" },
      { text: "Review the deck", owner: "Jane Doe" },
    ]);
  });

  it("strips bullets and trailing timestamps, including hour-long ones", () => {
    expect(parseActionItems("1. Do the thing [1:02:03]")).toEqual([{ text: "Do the thing" }]);
    expect(parseActionItems("• Ship it (12:34)")).toEqual([{ text: "Ship it" }]);
  });

  it("keeps a trailing parenthetical that is not a timestamp", () => {
    expect(parseActionItems("- Ping Ana (re: budget)")).toEqual([{ text: "Ping Ana (re: budget)" }]);
  });

  it("treats a flat, headingless list as ownerless items", () => {
    expect(parseActionItems("Ship it\nTest it")).toEqual([{ text: "Ship it" }, { text: "Test it" }]);
  });

  it("tolerates a colon inside the bold heading", () => {
    expect(parseActionItems("**Sandip:**\nDo it")).toEqual([{ text: "Do it", owner: "Sandip" }]);
  });

  it("yields nothing from empty or whitespace-only input", () => {
    expect(parseActionItems("")).toEqual([]);
    expect(parseActionItems("\n  \n\n")).toEqual([]);
  });
});

const TRANSCRIPT: FirefliesTranscript = {
  id: "ff-42",
  title: "Planning",
  date: "2026-07-19T10:00:00.000Z",
  url: "https://app.fireflies.ai/view/ff-42",
  overview: "Short and productive.",
  actionItemsRaw: "**Sandip**\n- Draft the spec (00:30)\n- Email the vendor (01:15)",
};

describe("transcriptToDraftItems", () => {
  it("emits one task per action item plus one note for the overview", () => {
    const items = transcriptToDraftItems(TRANSCRIPT);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.custom.kind)).toEqual(["task", "task", "note"]);
    expect(items[0]!.custom.title).toBe("Draft the spec");
    expect(items[0]!.custom.owner).toBe("Sandip");
    expect(items[2]!.custom.detail).toBe("Short and productive.");
  });

  it("gives every item the meeting source and the action_type gate", () => {
    const [first] = transcriptToDraftItems(TRANSCRIPT);
    expect(first!.capability_id).toBe("meeting-notes");
    expect(first!.type).toBe("meeting-note-item");
    expect(first!.context.source.id).toBe("fireflies:ff-42");
    expect(first!.context.source.link).toBe("https://app.fireflies.ai/view/ff-42");
    expect(first!.context.trigger_reason).toBe("action_type");
    expect(first!.context.provenance).toEqual(["meeting.transcribed", "meeting-notes.run"]);
  });

  it("keys dedupe stably per transcript, kind and index", () => {
    const items = transcriptToDraftItems(TRANSCRIPT);
    expect(items.map((i) => i.dedupe_key)).toEqual([
      "fireflies:ff-42:task:0",
      "fireflies:ff-42:task:1",
      "fireflies:ff-42:note",
    ]);
    // Stable across runs — a redelivery upserts, never duplicates.
    expect(transcriptToDraftItems(TRANSCRIPT).map((i) => i.dedupe_key)).toEqual(
      items.map((i) => i.dedupe_key),
    );
  });

  it("omits the note when there is no overview", () => {
    const items = transcriptToDraftItems({ ...TRANSCRIPT, overview: "   " });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.custom.kind === "task")).toBe(true);
  });

  it("files nothing for a meeting with no follow-ups and no overview", () => {
    expect(transcriptToDraftItems({ ...TRANSCRIPT, actionItemsRaw: "", overview: "" })).toEqual([]);
  });
});
