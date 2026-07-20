/**
 * The v0 anchor (TECH-SPEC §12 steps 10 and 15).
 *
 * Success criterion, quoted from the spec: "no wrap/meeting row hits Notion
 * without an explicit approve or edit-then-approve." These tests are the
 * executable form of that sentence.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getActionItem, listActionItems, listAuditTrail } from "../src/store/action-items.js";
import { harness, wrapItem } from "./helpers.js";

describe("capability registry loads the anchor capabilities", () => {
  it("registers wrap and meeting from capabilities/", () => {
    const { db } = harness();
    const ids = db
      .prepare<{ id: string }>("SELECT id FROM capabilities ORDER BY id")
      .all()
      .map((r) => r.id);
    expect(ids).toContain("wrap");
    expect(ids).toContain("meeting");
  });

  it("does not degrade either one, so pm-os.item.file is really registered", async () => {
    const h = harness();
    const result = await h.actionCenter.ingest("wrap", [wrapItem()]);
    expect(result.rejected).toEqual([]);
    const item = getActionItem(h.db, result.accepted[0]!.id)!;
    expect(item.execution.capability).toBe("pm-os.item.file");
    expect(item.execution.mode).toBe("automated");
  });
});

describe("the review gate", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("escalates a wrap item instead of filing it", async () => {
    const result = await h.actionCenter.ingest("wrap", [wrapItem()]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.status).toBe("pending");
    expect(result.accepted[0]!.policy.outcome).toBe("escalate");
    expect(result.accepted[0]!.policy.matched_rule).toBe("manifest:escalate_when");

    // The criterion: nothing was written.
    expect(h.notionDecision.calls).toEqual([]);
    expect(listActionItems(h.db, { status: "pending" })).toHaveLength(1);
  });

  it("escalates a meeting item instead of filing it", async () => {
    const result = await h.actionCenter.ingest("meeting", [
      {
        ...wrapItem(),
        type: "meeting-item-review",
        custom: {
          ...wrapItem().custom,
          meeting_topic: "Storage review",
          meeting_date: "2026-07-19",
          meeting_note_path: "Areas/Meetings/2026-07-19 - Storage review.md",
        },
      },
    ]);
    expect(result.accepted[0]!.status).toBe("pending");
    expect(h.notionDecision.calls).toEqual([]);
  });

  it("files only after an explicit approve", async () => {
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;

    expect(h.notionDecision.calls).toEqual([]);

    const executed = await h.actionCenter.respond(id, { response_id: "approve", actor: "sandip" });

    expect(executed.status).toBe("executed");
    expect(h.notionDecision.calls).toHaveLength(1);
    // pm-os.item.file translates the generic item into the Notion decision
    // shape: `detail` becomes `rationale`, and `kind` is consumed by routing
    // rather than forwarded.
    expect(h.notionDecision.calls[0]).toEqual({
      title: "Use node:sqlite instead of better-sqlite3",
      rationale: "No prebuilt binary for Node 26",
      evidence: "pnpm refused to run the build script",
      project: "Samaritan",
    });
  });

  it("files the edited payload on edit-then-approve, and records the diff", async () => {
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;

    await h.actionCenter.respond(id, {
      response_id: "edit_approve",
      actor: "sandip",
      edited_payload: {
        ...wrapItem().custom,
        title: "Use node:sqlite (Node 26 has no better-sqlite3 prebuild)",
      },
    });

    expect(h.notionDecision.calls[0]).toMatchObject({
      title: "Use node:sqlite (Node 26 has no better-sqlite3 prebuild)",
    });

    const approval = listAuditTrail(h.db, id).find((e) => e.actor === "sandip")!;
    expect(approval.payload_diff).toBeDefined();
  });

  it("files nothing when Sandip rejects", async () => {
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const rejected = await h.actionCenter.respond(accepted[0]!.id, { response_id: "reject" });

    expect(rejected.status).toBe("rejected");
    expect(h.notionDecision.calls).toEqual([]);
  });

  it("files nothing when Sandip defers", async () => {
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const deferred = await h.actionCenter.respond(accepted[0]!.id, { response_id: "defer" });

    expect(deferred.status).toBe("deferred");
    expect(h.notionDecision.calls).toEqual([]);
  });

  it("refuses a response the manifest does not declare", async () => {
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    await expect(
      h.actionCenter.respond(accepted[0]!.id, { response_id: "file_it_quietly" }),
    ).rejects.toThrow(/not an allowed response/);
    expect(h.notionDecision.calls).toEqual([]);
  });
});

describe("routing by kind", () => {
  it("sends an insight to the Insights database, not Decisions", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [
      wrapItem({
        dedupe_key: "wrap:sess:insight",
        custom: {
          kind: "insight",
          title: "pnpm blocks build scripts by default now",
          detail: "Needs onlyBuiltDependencies",
          project: "Samaritan",
          owner: "",
          due: "",
          evidence: "",
        },
      }),
    ]);
    await h.actionCenter.respond(accepted[0]!.id, { response_id: "approve" });

    expect(h.notionInsight.calls).toHaveLength(1);
    expect(h.notionDecision.calls).toEqual([]);
  });

  it("stages a task rather than claiming it filed one, since TickTick is guided-only", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [
      wrapItem({
        dedupe_key: "wrap:sess:task",
        custom: {
          kind: "task",
          title: "Add a Notion token to the Keychain",
          detail: "",
          project: "Samaritan",
          owner: "sandip",
          due: "2026-07-21",
          evidence: "",
        },
      }),
    ]);

    const staged = await h.actionCenter.respond(accepted[0]!.id, { response_id: "approve" });

    // §5.3: staged is not executed. The loop closes only when Sandip confirms.
    expect(staged.status).toBe("awaiting_confirmation");

    const confirmed = h.actionCenter.confirm(staged.id, { actor: "sandip" });
    expect(confirmed.status).toBe("executed");
  });

  it("lets Sandip reopen something he did not actually do", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [
      wrapItem({
        dedupe_key: "wrap:sess:task2",
        custom: {
          kind: "task",
          title: "Book the venue",
          detail: "",
          project: "",
          owner: "sandip",
          due: "",
          evidence: "",
        },
      }),
    ]);
    const staged = await h.actionCenter.respond(accepted[0]!.id, { response_id: "approve" });
    const reopened = h.actionCenter.reopen(staged.id, { reason: "didn't do it" });
    expect(reopened.status).toBe("pending");
  });
});

describe("ingest validation", () => {
  it("rejects an item whose custom payload does not match the manifest", async () => {
    const h = harness();
    const result = await h.actionCenter.ingest("wrap", [
      wrapItem({ custom: { kind: "decision", title: "Only half the fields" } }),
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]!.errors.join(" ")).toMatch(/detail|project|owner/);
  });

  it("rejects an unknown action-item type", async () => {
    const h = harness();
    const result = await h.actionCenter.ingest("wrap", [wrapItem({ type: "made-up-type" })]);
    expect(result.rejected[0]!.errors.join(" ")).toMatch(/not an action-item type/);
  });

  it("keeps good items when one item in the batch is bad", async () => {
    const h = harness();
    const result = await h.actionCenter.ingest("wrap", [
      wrapItem({ dedupe_key: "good" }),
      wrapItem({ dedupe_key: "bad", custom: { kind: "decision" } }),
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });
});

describe("re-ingest (§5.1)", () => {
  it("supersedes an unsettled draft in place and rolls review state back", async () => {
    const h = harness();
    const first = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = first.accepted[0]!.id;

    const second = await h.actionCenter.ingest("wrap", [
      wrapItem({ custom: { ...wrapItem().custom, title: "Revised title" } }),
    ]);

    expect(second.accepted[0]!.id).toBe(id);
    const item = getActionItem(h.db, id)!;
    expect(item.custom["title"]).toBe("Revised title");
    expect(item.status).toBe("pending");

    const superseded = listAuditTrail(h.db, id).find(
      (e) => e.reason === "superseded_by_reingest",
    );
    expect(superseded).toBeDefined();
    expect(superseded!.payload_diff).toBeDefined();
  });

  it("inserts a fresh row rather than mutating a settled one", async () => {
    const h = harness();
    const first = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const firstId = first.accepted[0]!.id;
    await h.actionCenter.respond(firstId, { response_id: "approve" });
    expect(getActionItem(h.db, firstId)!.status).toBe("executed");

    const second = await h.actionCenter.ingest("wrap", [wrapItem()]);
    expect(second.accepted[0]!.id).not.toBe(firstId);
    expect(getActionItem(h.db, firstId)!.status).toBe("executed");
    expect(getActionItem(h.db, second.accepted[0]!.id)!.status).toBe("pending");
  });
});

describe("audit completeness", () => {
  it("records the whole path from ingest to filed", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;
    await h.actionCenter.respond(id, { response_id: "approve", actor: "sandip" });

    const trail = listAuditTrail(h.db, id);
    expect(trail.map((e) => e.to_status)).toEqual(["pending", "approved", "executed"]);
    expect(trail.map((e) => e.actor)).toEqual(["capability", "sandip", "system"]);
    // The approval is attributable to a person, which is the point of the gate.
    expect(trail[1]!.reason).toContain("approve");
  });

  it("records an execution row keyed to the item and its dispatch generation", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;
    await h.actionCenter.respond(id, { response_id: "approve" });

    const row = h.db
      .prepare<{ idempotency_key: string; status: string; attempt: number }>(
        "SELECT idempotency_key, status, attempt FROM executions WHERE action_item_id = ?",
      )
      .get(id);
    // The generation suffix is what lets a reopened item dispatch a genuinely
    // different version instead of replaying the first attempt forever. It is 0
    // here because nothing has been reopened. See test/confirm.test.ts.
    expect(row).toMatchObject({ idempotency_key: `${id}:0`, status: "succeeded", attempt: 1 });
  });
});
