/**
 * The risk rules through the real ingest path (TECH-SPEC §5.6, §9).
 *
 * The evaluate() unit tests prove the rules; this proves the wiring — that the
 * config's `policy` block actually reaches the Policy Engine at ingest. The same
 * newsletter item (which asks to auto-file) either auto-completes or escalates
 * purely by the value threshold the ActionCenter was handed, so a broken wire
 * would flip this test even though every unit test stays green.
 */
import { describe, expect, it } from "vitest";
import { harness, testContext } from "./helpers.js";

function newsletterDraft(over: { worth_acting: boolean; value?: number; dedupe_key: string }) {
  return {
    capability_id: "newsletter-digest",
    type: "newsletter-digest-review",
    context: testContext({
      confidence: 0.9,
      ...(over.value !== undefined ? { value: over.value } : {}),
    }),
    custom: {
      kind: "insight",
      title: "Retrieval evals roundup",
      detail: "Three links on evals worth a look.",
      project: "PM-OS",
      owner: "sandip",
      due: "none",
      evidence: "https://example/newsletter",
      worth_acting: over.worth_acting,
      top_links: ["https://example/a"],
      relevance_notes: "matches an active project",
    },
    dedupe_key: over.dedupe_key,
  };
}

describe("policy risk rules through ingest (§9)", () => {
  it("escalates a would-be auto-complete once value crosses the configured threshold", async () => {
    const h = harness({ policyConfig: { valueThreshold: 10, escalateIrreversible: true } });
    const result = await h.actionCenter.ingest("newsletter-digest", [
      newsletterDraft({ worth_acting: false, value: 50, dedupe_key: "nl-high" }),
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.policy.outcome).toBe("escalate");
    expect(result.accepted[0]?.policy.matched_rule).toBe("risk:value_threshold");
    expect(result.accepted[0]?.status).toBe("pending");
  });

  it("auto-completes the identical shape below the threshold", async () => {
    const h = harness({ policyConfig: { valueThreshold: 10, escalateIrreversible: true } });
    const result = await h.actionCenter.ingest("newsletter-digest", [
      newsletterDraft({ worth_acting: false, value: 5, dedupe_key: "nl-low" }),
    ]);

    expect(result.accepted[0]?.policy.outcome).toBe("auto_complete");
    expect(result.accepted[0]?.policy.matched_rule).toBe("manifest:auto_complete_when");
  });

  it("uses the engine's default threshold when no policyConfig is wired in", async () => {
    // No policyConfig on the ActionCenter → DEFAULT_POLICY_CONFIG (threshold 100).
    // A value of 50 is below it, so this auto-completes — proving the default is
    // 100 and not 0 (which would escalate everything with any value at all).
    const h = harness();
    const result = await h.actionCenter.ingest("newsletter-digest", [
      newsletterDraft({ worth_acting: false, value: 50, dedupe_key: "nl-default" }),
    ]);

    expect(result.accepted[0]?.policy.outcome).toBe("auto_complete");
  });
});
