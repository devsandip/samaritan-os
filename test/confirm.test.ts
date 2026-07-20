/**
 * `awaiting_confirmation` and re-ingest (TECH-SPEC §5.1 branch 2a, §5.3).
 *
 * An item is in `awaiting_confirmation` when the OS has already dispatched:
 * a TickTick task staged, a deep link issued. Something exists in the world and
 * `execution.payload` is the only record of it.
 *
 * §5.1 used to file this with the statuses a re-ingest may supersede in place,
 * on the grounds that "nothing external has been committed yet". That is not
 * true of a dispatched item, and following it produced three failures at once:
 * the row rolled back to `pending`, the overwrite of `execution` destroyed the
 * deep link, and `confirm()`/`reopen()` then refused the item because they only
 * answer `awaiting_confirmation`, so it could not close its own loop.
 */
import { describe, expect, it, vi } from "vitest";
import {
  getActionItem,
  listActionItems,
  listAuditTrail,
} from "../src/store/action-items.js";
import { harness, wrapItem, type Harness } from "./helpers.js";

/** A wrap draft whose `kind` routes to an adapter that stages rather than commits. */
function taskDraft(overrides: Record<string, unknown> = {}) {
  return wrapItem({
    custom: {
      kind: "task",
      title: "Send the vendor the revised scope",
      detail: "",
      project: "Samaritan",
      owner: "sandip",
      due: "2026-07-25",
      evidence: "",
    },
    dedupe_key: "wrap:sess-await:0",
    ...overrides,
  });
}

/** The same draft with different content, under the same dedupe key. */
function revisedDraft() {
  return taskDraft({
    custom: {
      kind: "task",
      title: "Send the vendor the REVISED scope",
      detail: "now includes the Q3 addendum",
      project: "Samaritan",
      owner: "sandip",
      due: "2026-07-28",
      evidence: "",
    },
  });
}

/**
 * Ingests and approves one task, leaving it dispatched.
 *
 * The assertions inside are load-bearing: `kind: task` reaches
 * `ticktick.task.create` through `pm-os.item.file`, and that adapter always
 * reports "staged". If the manifest or the routing table drifts so that this
 * lands anywhere but `awaiting_confirmation`, every test below would silently
 * start testing nothing, so it fails here instead.
 */
async function dispatched(h: Harness): Promise<string> {
  const { accepted, rejected } = await h.actionCenter.ingest("wrap", [taskDraft()]);
  expect(rejected).toEqual([]);
  const id = accepted[0]!.id;

  const staged = await h.actionCenter.respond(id, { response_id: "approve" });
  expect(staged.status).toBe("awaiting_confirmation");
  expect(staged.execution.payload["_guided_link"]).toBe("ticktick://");
  return id;
}

describe("a re-ingest against a dispatched item", () => {
  it("leaves the status alone", async () => {
    const h = harness();
    const id = await dispatched(h);

    await h.actionCenter.ingest("wrap", [revisedDraft()]);

    expect(getActionItem(h.db, id)?.status).toBe("awaiting_confirmation");
  });

  it("keeps the deep link and instructions", async () => {
    const h = harness();
    const id = await dispatched(h);

    await h.actionCenter.ingest("wrap", [revisedDraft()]);

    // The link is the only thing telling Sandip where the staged work went.
    // There is no way to re-derive it without dispatching again.
    const after = getActionItem(h.db, id)!;
    expect(after.execution.payload["_guided_link"]).toBe("ticktick://");
    expect(after.execution.payload["_guided_instructions"]).toBeTruthy();
  });

  it("leaves the item able to close its own loop", async () => {
    const h = harness();
    const id = await dispatched(h);

    await h.actionCenter.ingest("wrap", [revisedDraft()]);

    // The sharpest statement of the bug: both endpoints answer only
    // `awaiting_confirmation`, so a rollback stranded the item with no way out.
    expect(h.actionCenter.confirm(id).status).toBe("executed");
  });

  it("leaves reopen available too", async () => {
    const h = harness();
    const id = await dispatched(h);

    await h.actionCenter.ingest("wrap", [revisedDraft()]);

    expect(h.actionCenter.reopen(id, { reason: "did not do it" }).status).toBe("pending");
  });

  it("holds the old content rather than showing content that was never staged", async () => {
    const h = harness();
    const id = await dispatched(h);

    await h.actionCenter.ingest("wrap", [revisedDraft()]);

    // Refreshing in place would leave the amber chip asserting "we staged this"
    // over a version that was never staged, and confirm() would then record
    // `executed` for work the OS never dispatched.
    expect(getActionItem(h.db, id)?.custom["title"]).toBe("Send the vendor the revised scope");
  });

  it("creates no second row", async () => {
    const h = harness();
    const id = await dispatched(h);

    const second = await h.actionCenter.ingest("wrap", [revisedDraft()]);

    expect(second.accepted[0]?.id).toBe(id);
    expect(second.accepted[0]?.status).toBe("awaiting_confirmation");
    expect(listActionItems(h.db, {})).toHaveLength(1);
  });

  it("preserves the row id, which is the idempotency key", async () => {
    const h = harness();
    const id = await dispatched(h);

    await h.actionCenter.ingest("wrap", [revisedDraft()]);

    // §10 scopes idempotency to the item id, and the registry replays any key
    // that already staged rather than calling the adapter. Forking would mint a
    // new id, miss the guard, and stage a second task for real. This is the
    // assertion that pins why branch 2a is a hold and not a fork.
    const replay = await h.execution.execute({
      action_item_id: id,
      capability: "ticktick.task.create",
      mode: "guided",
      payload: getActionItem(h.db, id)!.execution.payload,
      idempotency_key: id,
    });
    expect(replay.status).toBe("staged");

    const attempts = h.db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM executions WHERE idempotency_key = ?")
      .get(id);
    expect(attempts?.n).toBe(1);
  });

  it("records the re-emission instead of losing it", async () => {
    const h = harness();
    const id = await dispatched(h);

    await h.actionCenter.ingest("wrap", [revisedDraft()]);

    const trail = listAuditTrail(h.db, id);
    const held = trail.find((e) => e.reason === "reingest_held_awaiting_confirmation");
    expect(held).toBeDefined();
    expect(held?.actor).toBe("capability");
    // Same on both ends: this is a note, not a move.
    expect(held?.from_status).toBe("awaiting_confirmation");
    expect(held?.to_status).toBe("awaiting_confirmation");
    // The content that was withheld is still recoverable from the trail.
    expect(JSON.stringify(held?.payload_diff)).toContain("REVISED");
  });

  it("appends no transition that did not happen", async () => {
    const h = harness();
    const id = await dispatched(h);

    await h.actionCenter.ingest("wrap", [revisedDraft()]);

    // A rollback wrote `awaiting_confirmation -> pending, actor capability`,
    // which the trail renders as "the capability sent this back to the inbox".
    // Nothing sent it anywhere. `from_status === null` is the ingest event that
    // created the row, which is a real move and stays.
    const moves = listAuditTrail(h.db, id).filter((e) => e.from_status !== e.to_status);
    expect(moves.at(-1)?.to_status).toBe("awaiting_confirmation");
    expect(moves.some((e) => e.from_status !== null && e.to_status === "pending")).toBe(false);
  });

  it("does not notify again", async () => {
    const notify = vi.fn(async () => undefined);
    const h = harness({ delivery: { notify } });
    await dispatched(h);
    notify.mockClear();

    await h.actionCenter.ingest("wrap", [revisedDraft()]);

    // It is already in the Inbox with an amber chip. A fresh ping saying
    // something needs a decision would be a second claim on his attention for
    // work he has already been handed.
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not auto-execute through the hold", async () => {
    const h = harness();
    const id = await dispatched(h);

    // `awaiting_confirmation -> approved` is not a legal transition, so a policy
    // rule that fires here would throw inside ingest and land the whole draft in
    // rejected[]. The hold has to return before policy is acted on.
    const result = await h.actionCenter.ingest("wrap", [revisedDraft()]);
    expect(result.rejected).toEqual([]);
    expect(getActionItem(h.db, id)?.status).toBe("awaiting_confirmation");
  });
});

describe("the way through", () => {
  it("accepts the refreshed content once Sandip says the handoff is void", async () => {
    const h = harness();
    const id = await dispatched(h);

    await h.actionCenter.ingest("wrap", [revisedDraft()]);
    h.actionCenter.reopen(id, { reason: "did not do it" });

    // Back to pending, so the ordinary supersede applies and the newer content
    // lands. This is the documented route, not a workaround.
    await h.actionCenter.ingest("wrap", [revisedDraft()]);

    const after = getActionItem(h.db, id)!;
    expect(after.status).toBe("pending");
    expect(after.custom["title"]).toBe("Send the vendor the REVISED scope");
  });

  it("still supersedes a pending item in place, unchanged", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [taskDraft()]);
    const id = accepted[0]!.id;

    await h.actionCenter.ingest("wrap", [revisedDraft()]);

    // The hold is scoped to dispatched items. Everything else behaves as before.
    const after = getActionItem(h.db, id)!;
    expect(after.status).toBe("pending");
    expect(after.custom["title"]).toBe("Send the vendor the REVISED scope");
    expect(listActionItems(h.db, {})).toHaveLength(1);
  });
});

describe("the registry's replay", () => {
  it("carries the deep link, not just the result", async () => {
    const h = harness();
    const id = await dispatched(h);
    const payload = getActionItem(h.db, id)!.execution.payload;

    // §10 replays a settled attempt rather than calling the adapter again. Only
    // `result.result` was persisted, so `guided_link` and `guided_instructions`
    // were dropped on write and a replay handed back a "staged" with nothing to
    // open. Today nothing user-facing depends on it, because execute() spreads
    // the item's existing payload over the result and the old link survives by
    // accident. That is a coincidence, not a design, and the branch 2a hold is
    // what keeps it true.
    const replay = await h.execution.execute({
      action_item_id: id,
      capability: "ticktick.task.create",
      mode: "guided",
      payload,
      idempotency_key: id,
    });

    expect(replay.status).toBe("staged");
    expect(replay.guided_link).toBe("ticktick://");
    expect(replay.guided_instructions).toBeTruthy();
  });
});
