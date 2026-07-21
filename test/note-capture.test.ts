import { describe, expect, it } from "vitest";
import { EventBus } from "../src/events/index.js";
import { runCapability } from "../src/run-layer/index.js";
import { buildCaptureItem, run } from "../capabilities/note-capture/index.js";
import { harness, type Harness } from "./helpers.js";

const FIRED_AT = "2026-07-21T10:00:00.000Z";

function notePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { path: "Inbox/call-dentist.md", title: "call-dentist", folder: "Inbox", kind: "note", ...over };
}

describe("buildCaptureItem", () => {
  it("turns a capture into an escalating task candidate", () => {
    const item = buildCaptureItem({
      path: "Inbox/call-dentist.md",
      title: "call-dentist",
      folder: "Inbox",
      capturedAt: FIRED_AT,
    });
    expect(item).toMatchObject({
      capability_id: "note-capture",
      type: "note-capture-review",
      custom: { kind: "task", title: "call-dentist", folder: "Inbox", captured_at: FIRED_AT },
      dedupe_key: "note-capture:Inbox/call-dentist.md",
    });
    expect(item.context.source).toEqual({ kind: "note", id: "Inbox/call-dentist.md", link: "Inbox/call-dentist.md" });
    // Certain it happened; the open question is what to do, so confidence is 1
    // and the manifest — not this number — is what escalates.
    expect(item.context.confidence).toBe(1);
  });
});

describe("note-capture run()", () => {
  it("emits one item for a note.created payload", async () => {
    const result = await run({
      capability_id: "note-capture",
      trigger: { mode: "event", firedAt: FIRED_AT, payload: notePayload() },
      inputs: {},
      memory: {},
      emit: async () => ({ accepted: [], rejected: [] }) as never,
    });
    expect(result.status).toBe("ok");
    expect(result.action_items).toHaveLength(1);
    expect(result.action_items[0]?.custom["title"]).toBe("call-dentist");
  });

  it("falls back to the filename when the payload has no title", async () => {
    const result = await run({
      capability_id: "note-capture",
      trigger: { mode: "event", firedAt: FIRED_AT, payload: { path: "Inbox/Idea 42.md", folder: "Inbox" } },
      inputs: {},
      memory: {},
      emit: async () => ({ accepted: [], rejected: [] }) as never,
    });
    expect(result.action_items[0]?.custom["title"]).toBe("Idea 42");
  });

  it("emits nothing when the trigger carries no note path", async () => {
    const result = await run({
      capability_id: "note-capture",
      trigger: { mode: "event", firedAt: FIRED_AT, payload: {} },
      inputs: {},
      memory: {},
      emit: async () => ({ accepted: [], rejected: [] }) as never,
    });
    expect(result.action_items).toEqual([]);
  });
});

/**
 * End to end through the real registry: proves the manifest, its filter, and the
 * index agree — a note.created in Inbox/ routes here and lands a valid, escalated
 * item, and one outside Inbox/ does not. A drifting manifest fails here, not in a
 * room.
 */
describe("note-capture against the real Event Bus", () => {
  function wireRealBus(h: Harness, fired: string[]): EventBus {
    return new EventBus({
      db: h.db,
      capabilities: h.capabilities,
      fire: async (capabilityId, event) => {
        fired.push(capabilityId);
        await runCapability(
          { db: h.db, capabilities: h.capabilities, actionCenter: h.actionCenter },
          capabilityId,
          { trigger: { mode: "event", firedAt: event.occurred_at ?? FIRED_AT, payload: event.payload } },
        );
      },
    });
  }

  function itemsFor(h: Harness): { type: string; status: string }[] {
    return h.db
      .prepare<{ type: string; status: string }>(
        "SELECT type, status FROM action_items WHERE capability_id = 'note-capture'",
      )
      .all();
  }

  it("captures a note dropped in Inbox/ as an escalated item", async () => {
    const h = harness();
    const fired: string[] = [];
    await wireRealBus(h, fired).publish({
      type: "note.created",
      id: "file:/vault/Inbox/call-dentist.md@1",
      payload: notePayload(),
    });

    expect(fired).toContain("note-capture");
    const items = itemsFor(h);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("note-capture-review");
    // escalate_when: "true" → surfaced for review, never auto-filed.
    expect(items[0]?.status).toBe("pending");
  });

  it("ignores a note created outside Inbox/", async () => {
    const h = harness();
    const fired: string[] = [];
    await wireRealBus(h, fired).publish({
      type: "note.created",
      id: "file:/vault/Areas/weekly.md@1",
      payload: notePayload({ path: "Areas/weekly.md", title: "weekly", folder: "Areas" }),
    });

    expect(fired).not.toContain("note-capture");
    expect(itemsFor(h)).toHaveLength(0);
  });
});
