import { describe, expect, it } from "vitest";
import {
  ActionItemNotFoundError,
  canTransition,
  createActionItem,
  getActionItem,
  getActionItemByDedupeKey,
  IllegalTransitionError,
  listActionItems,
  listAuditTrail,
  releaseDedupeKey,
  transition,
} from "../src/store/action-items.js";
import { testContext, testDraft, testStore } from "./helpers.js";

describe("createActionItem", () => {
  it("inserts in pending and records the ingest event", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());

    expect(item.status).toBe("pending");
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getActionItem(db, item.id)?.custom).toEqual({ title: "Use SQLite", kind: "decision" });

    const trail = listAuditTrail(db, item.id);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ from_status: null, to_status: "pending", actor: "capability" });
  });

  it("round-trips context, responses and execution through the JSON columns", () => {
    const db = testStore();
    const created = createActionItem(db, testDraft());
    const read = getActionItem(db, created.id)!;

    expect(read.context).toEqual(created.context);
    expect(read.responses).toEqual(["approve", "reject"]);
    expect(read.execution).toEqual(created.execution);
  });

  it("finds an item by its dedupe key", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft({ dedupe_key: "k-1" }));
    expect(getActionItemByDedupeKey(db, "test-cap", "k-1")?.id).toBe(item.id);
    expect(getActionItemByDedupeKey(db, "test-cap", "nope")).toBeUndefined();
  });

  it("refuses a second item with the same (capability_id, dedupe_key)", () => {
    const db = testStore();
    createActionItem(db, testDraft({ dedupe_key: "same" }));
    expect(() => createActionItem(db, testDraft({ dedupe_key: "same" }))).toThrow(/UNIQUE/i);
  });
});

describe("transition", () => {
  it("moves through the review-then-execute path", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());

    const reviewed = transition(db, { id: item.id, to: "in_review", actor: "system" });
    expect(reviewed.status).toBe("in_review");

    const approved = transition(db, { id: item.id, to: "approved", actor: "sandip" });
    expect(approved.status).toBe("approved");

    const executed = transition(db, { id: item.id, to: "executed", actor: "system" });
    expect(executed.status).toBe("executed");
  });

  it("stages to awaiting_confirmation and closes out on confirm (§5.3)", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());
    transition(db, { id: item.id, to: "approved", actor: "policy" });
    transition(db, { id: item.id, to: "awaiting_confirmation", actor: "system", reason: "staged" });
    const done = transition(db, { id: item.id, to: "executed", actor: "sandip", reason: "confirmed" });
    expect(done.status).toBe("executed");
  });

  it("reopens an awaiting_confirmation item back into the Inbox", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());
    transition(db, { id: item.id, to: "approved", actor: "policy" });
    transition(db, { id: item.id, to: "awaiting_confirmation", actor: "system" });
    const reopened = transition(db, { id: item.id, to: "pending", actor: "sandip", reason: "didn't do it" });
    expect(reopened.status).toBe("pending");
  });

  it("rejects an illegal move and leaves no audit row behind", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());
    transition(db, { id: item.id, to: "rejected", actor: "sandip" });

    expect(() => transition(db, { id: item.id, to: "executed", actor: "system" })).toThrow(
      IllegalTransitionError,
    );

    expect(getActionItem(db, item.id)?.status).toBe("rejected");
    // create + reject only. The failed attempt must not have written anything.
    expect(listAuditTrail(db, item.id)).toHaveLength(2);
  });

  it("treats executed, rejected and expired as terminal", () => {
    expect(canTransition("executed", "pending")).toBe(false);
    expect(canTransition("rejected", "approved")).toBe(false);
    expect(canTransition("expired", "pending")).toBe(false);
    expect(canTransition("failed", "approved")).toBe(true);
  });

  it("throws for an unknown id", () => {
    const db = testStore();
    expect(() =>
      transition(db, { id: "00000000-0000-4000-8000-000000000000", to: "approved", actor: "sandip" }),
    ).toThrow(ActionItemNotFoundError);
  });

  it("records a payload_diff on edit-then-approve", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());

    transition(db, {
      id: item.id,
      to: "approved",
      actor: "sandip",
      reason: "edited then approved",
      patch: { custom: { title: "Use node:sqlite", kind: "decision" } },
    });

    const trail = listAuditTrail(db, item.id);
    const approval = trail.at(-1)!;
    expect(approval.actor).toBe("sandip");
    expect(approval.payload_diff).toEqual({
      custom: {
        from: { title: "Use SQLite", kind: "decision" },
        to: { title: "Use node:sqlite", kind: "decision" },
      },
    });
    expect(getActionItem(db, item.id)?.custom).toEqual({
      title: "Use node:sqlite",
      kind: "decision",
    });
  });

  it("omits payload_diff when a patch changes nothing", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());
    transition(db, {
      id: item.id,
      to: "approved",
      actor: "sandip",
      patch: { custom: { title: "Use SQLite", kind: "decision" } },
    });
    expect(listAuditTrail(db, item.id).at(-1)!.payload_diff).toBeUndefined();
  });

  it("leaves one audit row per move, always", () => {
    const db = testStore();
    const item = createActionItem(db, testDraft());
    const moves = ["in_review", "approved", "awaiting_confirmation", "executed"] as const;
    for (const to of moves) transition(db, { id: item.id, to, actor: "system" });

    const trail = listAuditTrail(db, item.id);
    expect(trail).toHaveLength(moves.length + 1);
    expect(trail.map((e) => e.to_status)).toEqual(["pending", ...moves]);
    // Consecutive rows chain: each from_status is the previous to_status.
    for (let i = 1; i < trail.length; i++) {
      expect(trail[i]!.from_status).toBe(trail[i - 1]!.to_status);
    }
  });
});

describe("listActionItems", () => {
  function seeded() {
    const db = testStore();
    createActionItem(db, testDraft({ dedupe_key: "a", priority: "low" }));
    createActionItem(db, testDraft({ dedupe_key: "b", priority: "urgent" }));
    const c = createActionItem(db, testDraft({ dedupe_key: "c", priority: "high" }));
    transition(db, { id: c.id, to: "approved", actor: "policy" });
    return db;
  }

  it("filters by status", () => {
    const db = seeded();
    expect(listActionItems(db, { status: "pending" })).toHaveLength(2);
    expect(listActionItems(db, { status: "approved" })).toHaveLength(1);
    expect(listActionItems(db, { status: ["pending", "approved"] })).toHaveLength(3);
  });

  it("orders urgent before high before low", () => {
    const db = seeded();
    expect(listActionItems(db).map((i) => i.priority)).toEqual(["urgent", "high", "low"]);
  });

  it("honours limit and offset", () => {
    const db = seeded();
    expect(listActionItems(db, { limit: 2 })).toHaveLength(2);
    expect(listActionItems(db, { limit: 2, offset: 2 })).toHaveLength(1);
  });

  it("filters by capability and type", () => {
    const db = seeded();
    expect(listActionItems(db, { capability_id: "test-cap" })).toHaveLength(3);
    expect(listActionItems(db, { capability_id: "other" })).toHaveLength(0);
    expect(listActionItems(db, { type: "wrap-item-review" })).toHaveLength(3);
  });
});

describe("releaseDedupeKey", () => {
  it("frees the original key so a re-fire can insert under it", () => {
    const db = testStore();
    const first = createActionItem(db, testDraft({ dedupe_key: "occurrence-1" }));
    transition(db, { id: first.id, to: "approved", actor: "policy" });
    transition(db, { id: first.id, to: "executed", actor: "system" });

    const superseded = releaseDedupeKey(db, getActionItem(db, first.id)!);
    expect(superseded).toBe(`occurrence-1:superseded:${first.id}`);

    const second = createActionItem(
      db,
      testDraft({ dedupe_key: "occurrence-1", context: testContext({ confidence: 0.5 }) }),
    );
    expect(second.id).not.toBe(first.id);
    expect(getActionItemByDedupeKey(db, "test-cap", "occurrence-1")?.id).toBe(second.id);
    // The settled original is still there, untouched, under its suffixed key.
    expect(getActionItem(db, first.id)?.status).toBe("executed");
  });
});
