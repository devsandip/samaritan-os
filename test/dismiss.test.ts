/**
 * The universal dismiss (UI-SPEC §4.7).
 *
 * The case that matters is an item whose capability is gone: no manifest means
 * no declared response the daemon can resolve, and before this every response id
 * came back 409 `response_unknown`. The item then had no way out of the Inbox at
 * all, which is the one failure §4.7 exists to rule out.
 *
 * These tests unload a real capability rather than stubbing the lookup, because
 * the bug lived in the seam between the registry and the Action Center.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ActionCenterError } from "../src/action-center/index.js";
import { repoRoot } from "../src/config/index.js";
import { getActionItem, listAuditTrail, transition } from "../src/store/action-items.js";
import { CapabilityManifest, DISMISS_RESPONSE_ID, KebabId } from "../src/types/index.js";
import { harness, wrapItem, type Harness } from "./helpers.js";

const temps: string[] = [];

/** A copy of the real capabilities folder that a test is free to delete from. */
function scratchCapabilities(): string {
  const dir = mkdtempSync(join(tmpdir(), "samaritan-caps-"));
  temps.push(dir);
  cpSync(join(repoRoot(), "capabilities"), dir, { recursive: true });
  return dir;
}

/** Ingests one wrap item, then removes the capability that emitted it. */
async function orphaned(): Promise<{ h: Harness; id: string }> {
  const dir = scratchCapabilities();
  const h = harness({ capabilitiesDir: dir });

  const result = await h.actionCenter.ingest("wrap", [wrapItem()]);
  expect(result.rejected).toEqual([]);
  const id = result.accepted[0]!.id;

  rmSync(join(dir, "wrap"), { recursive: true });
  h.capabilities.reload();
  expect(h.capabilities.getType("wrap", "wrap-item-review")).toBeUndefined();

  return { h, id };
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

/**
 * The real wrap manifest with its discard response renamed. Starting from a file
 * the daemon actually loads means a failure below is about the id and not about
 * a hand-written fixture drifting from the schema.
 */
function wrapManifestDeclaring(responseId: string): unknown {
  const path = join(repoRoot(), "capabilities", "wrap", "manifest.yaml");
  const manifest = parseYaml(readFileSync(path, "utf8")) as {
    emits: { responses: { id: string }[] }[];
  };
  manifest.emits[0]!.responses.find((r) => r.id === "reject")!.id = responseId;
  return manifest;
}

describe("the reserved id", () => {
  it("is not a well-formed response id, so no manifest can declare it", () => {
    // This is the whole reservation. There is no rule saying "you may not use
    // this name": the id is not expressible as a KebabId, so a colliding
    // manifest cannot be written. If KebabId ever grows a colon, this fails and
    // the collision surfaces here rather than in someone's inbox.
    expect(KebabId.safeParse(DISMISS_RESPONSE_ID).success).toBe(false);
    expect(CapabilityManifest.safeParse(wrapManifestDeclaring(DISMISS_RESPONSE_ID)).success).toBe(
      false,
    );
  });

  it("leaves plain `dismiss` free, which the §4.6 worked example declares", () => {
    // Reserving the obvious word would have cost every capability author the
    // most natural name for a discard button and contradicted three spec
    // examples. Namespacing the OS's own id costs nobody anything.
    expect(CapabilityManifest.safeParse(wrapManifestDeclaring("reject")).success).toBe(true);
    expect(CapabilityManifest.safeParse(wrapManifestDeclaring("dismiss")).success).toBe(true);
  });

  it("leaves the real capabilities loadable", () => {
    const h = harness();
    expect(h.capabilities.problems()).toEqual([]);
    expect(h.capabilities.getType("wrap", "wrap-item-review")).toBeDefined();
  });
});

describe("an orphaned item", () => {
  it("refuses every declared response, pointing at the way out", async () => {
    const { h, id } = await orphaned();

    for (const responseId of ["approve", "reject", "defer"]) {
      const err = await h.actionCenter.respond(id, { response_id: responseId }).catch((e) => e);
      expect(err).toBeInstanceOf(ActionCenterError);
      expect((err as ActionCenterError).code).toBe("response_unknown");
      expect((err as ActionCenterError).status).toBe(409);
      // The message has to name the escape hatch: this error is the only place
      // it surfaces for anyone driving the API by hand.
      expect((err as ActionCenterError).message).toContain(DISMISS_RESPONSE_ID);
    }

    expect(getActionItem(h.db, id)?.status).toBe("pending");
  });

  it("accepts dismiss and lands in rejected", async () => {
    const { h, id } = await orphaned();

    const item = await h.actionCenter.respond(id, { response_id: DISMISS_RESPONSE_ID });
    expect(item.status).toBe("rejected");
    expect(getActionItem(h.db, id)?.status).toBe("rejected");
  });

  it("records who dismissed it and why, like any other decision", async () => {
    const { h, id } = await orphaned();
    await h.actionCenter.respond(id, { response_id: DISMISS_RESPONSE_ID, actor: "sandip" });

    const last = listAuditTrail(h.db, id).at(-1)!;
    expect(last.to_status).toBe("rejected");
    expect(last.actor).toBe("sandip");
    expect(last.reason).toBe("dismissed");
  });

  it("files nothing on the way out", async () => {
    const { h, id } = await orphaned();
    await h.actionCenter.respond(id, { response_id: DISMISS_RESPONSE_ID });

    expect(h.notionDecision.calls).toEqual([]);
    expect(h.notionInsight.calls).toEqual([]);
  });
});

describe("dismiss on a healthy item", () => {
  it("works even though no manifest declares it", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;

    // The manifest is loaded and lists approve/edit_approve/reject/defer. None
    // of them is "dismiss", and the item's own responses[] does not carry it
    // either, so both of respond()'s gates would refuse it if it were not
    // resolved ahead of them.
    expect(getActionItem(h.db, id)?.responses).not.toContain(DISMISS_RESPONSE_ID);

    const item = await h.actionCenter.respond(id, { response_id: DISMISS_RESPONSE_ID });
    expect(item.status).toBe("rejected");
    expect(h.notionDecision.calls).toEqual([]);
  });

  it("clears a deferred item, which is what the Deferred view's Drop sends", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;

    await h.actionCenter.respond(id, { response_id: "defer" });
    expect(getActionItem(h.db, id)?.status).toBe("deferred");

    const dropped = await h.actionCenter.respond(id, { response_id: DISMISS_RESPONSE_ID });
    expect(dropped.status).toBe("rejected");
    // Dropped for good: nothing left to resurface it.
    expect(dropped.defer_until).toBeNull();
    expect(await h.actionCenter.resurface()).toBe(0);
  });

  it("is idempotent on an item it already rejected", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;

    await h.actionCenter.respond(id, { response_id: DISMISS_RESPONSE_ID });
    // The store permits same-status re-entry by design, so a retried request
    // after a dropped response settles rather than 409ing at someone who has
    // already got what they asked for. The second press is still audited.
    const again = await h.actionCenter.respond(id, { response_id: DISMISS_RESPONSE_ID });
    expect(again.status).toBe("rejected");
    expect(listAuditTrail(h.db, id).filter((e) => e.reason === "dismissed")).toHaveLength(2);
  });

  it("is still refused on statuses the lifecycle closes off", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;

    transition(h.db, { id, to: "approved", actor: "sandip", reason: "test" });
    transition(h.db, { id, to: "executed", actor: "system", reason: "test" });

    // The universal fallback is a way out of the Inbox, not a way around the
    // transition table: an executed item is a record of something that happened.
    await expect(h.actionCenter.respond(id, { response_id: DISMISS_RESPONSE_ID })).rejects.toThrow(
      /cannot transition executed -> rejected/,
    );
  });

  it("does not reach past awaiting_confirmation, where reopen is the documented path", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;

    transition(h.db, { id, to: "approved", actor: "sandip", reason: "test" });
    transition(h.db, { id, to: "awaiting_confirmation", actor: "system", reason: "test" });

    // §4.8 rule 2 collapses this state to confirm / reopen, and the store agrees:
    // awaiting_confirmation has no edge to rejected. Reopen first, then dismiss.
    await expect(h.actionCenter.respond(id, { response_id: DISMISS_RESPONSE_ID })).rejects.toThrow(
      /cannot transition awaiting_confirmation -> rejected/,
    );

    h.actionCenter.reopen(id, { reason: "did not do it" });
    const item = await h.actionCenter.respond(id, { response_id: DISMISS_RESPONSE_ID });
    expect(item.status).toBe("rejected");
  });

  it("clears a failed item, so a broken adapter is not a permanent inbox row", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);
    const id = accepted[0]!.id;

    transition(h.db, { id, to: "approved", actor: "sandip", reason: "test" });
    transition(h.db, { id, to: "failed", actor: "system", reason: "notion 503" });

    const item = await h.actionCenter.respond(id, { response_id: DISMISS_RESPONSE_ID });
    expect(item.status).toBe("rejected");
  });
});

describe("responses that are neither declared nor reserved", () => {
  it("are refused as not allowed, and the error lists dismiss among the options", async () => {
    const h = harness();
    const { accepted } = await h.actionCenter.ingest("wrap", [wrapItem()]);

    const err = await h.actionCenter
      .respond(accepted[0]!.id, { response_id: "nuke-it" })
      .catch((e) => e);

    expect((err as ActionCenterError).code).toBe("response_not_allowed");
    expect((err as ActionCenterError).status).toBe(400);
    expect((err as ActionCenterError).message).toContain(DISMISS_RESPONSE_ID);
  });
});
