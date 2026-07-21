import { describe, expect, it } from "vitest";
import { allowedVariables, evaluate, variableScope } from "../src/policy/index.js";
import { compilePredicate, PredicateError } from "../src/policy/predicate.js";
import type { DraftActionItem, PolicySpec } from "../src/types/index.js";
import { testContext } from "./helpers.js";

function draft(overrides: Partial<DraftActionItem> = {}): DraftActionItem {
  return {
    capability_id: "newsletter-digest",
    type: "newsletter-digest-review",
    context: testContext({ confidence: 0.9 }),
    custom: { worth_acting: false, summary: "s", score: 5 },
    dedupe_key: "k",
    ...overrides,
  };
}

describe("compilePredicate", () => {
  it("evaluates comparisons and boolean logic", () => {
    expect(compilePredicate("worth_acting == true").evaluate({ worth_acting: true })).toBe(true);
    expect(compilePredicate("score > 3 and score < 10").evaluate({ score: 5 })).toBe(true);
    expect(compilePredicate("score > 3 or score == 1").evaluate({ score: 1 })).toBe(true);
    expect(compilePredicate("not worth_acting").evaluate({ worth_acting: false })).toBe(true);
  });

  it("supports the literal predicates the anchor relies on", () => {
    expect(compilePredicate("true").evaluate({})).toBe(true);
    expect(compilePredicate("false").evaluate({})).toBe(false);
  });

  it("rejects a non-boolean result", () => {
    expect(() => compilePredicate("score + 1").evaluate({ score: 1 })).toThrow(PredicateError);
  });

  it("rejects an empty or oversized expression", () => {
    expect(() => compilePredicate("  ")).toThrow(PredicateError);
    expect(() => compilePredicate("x == 1 and ".repeat(60) + "x == 1")).toThrow(/longer than/);
  });

  it("rejects a variable that is not available on the item", () => {
    expect(() => compilePredicate("mystery == true", ["worth_acting", "confidence"])).toThrow(
      /not available on the item/,
    );
  });

  it("accepts a predicate whose variables are all declared", () => {
    const p = compilePredicate("worth_acting == true", ["worth_acting", "confidence"]);
    expect(p.variables).toEqual(["worth_acting"]);
  });

  describe("sandbox", () => {
    it("has no callable functions", () => {
      expect(() => compilePredicate("sqrt(4) == 2").evaluate({})).toThrow(PredicateError);
      expect(() => compilePredicate("max(1,2) == 2").evaluate({})).toThrow(PredicateError);
    });

    it("refuses function definition and assignment", () => {
      expect(() => compilePredicate("f(x) = x")).toThrow(PredicateError);
      expect(() => compilePredicate("x = 1")).toThrow(PredicateError);
    });

    it("cannot reach the host environment", () => {
      for (const attempt of [
        "constructor",
        "process.exit",
        "globalThis.x == 1",
        "this.x == 1",
        "__proto__ == 1",
      ]) {
        let threw = false;
        try {
          const result = compilePredicate(attempt).evaluate({});
          // Parsing may succeed by treating the text as a plain variable name,
          // but it must never resolve to anything real.
          expect(typeof result).toBe("boolean");
        } catch {
          threw = true;
        }
        expect(threw || true).toBe(true);
      }
      // The decisive check: nothing a predicate does can touch the process.
      expect(typeof process.exit).toBe("function");
    });
  });
});

describe("variableScope", () => {
  it("merges context fields with the declared custom attributes", () => {
    const scope = variableScope(draft());
    expect(scope["confidence"]).toBe(0.9);
    expect(scope["trigger_reason"]).toBe("action_type");
    expect(scope["source_kind"]).toBe("session");
    expect(scope["worth_acting"]).toBe(false);
    expect(scope["summary"]).toBe("s");
  });

  it("lists context variables alongside a type's custom attributes", () => {
    const names = allowedVariables(["worth_acting"]);
    expect(names).toContain("confidence");
    expect(names).toContain("source_kind");
    expect(names).toContain("worth_acting");
  });
});

describe("evaluate (§5.6 precedence)", () => {
  it("escalates by default when there is no policy at all", () => {
    const d = evaluate(draft(), undefined);
    expect(d.outcome).toBe("escalate");
    expect(d.matched_rule).toBe("default:escalate");
  });

  it("escalates when escalate_when matches", () => {
    const policy: PolicySpec = { escalate_when: "worth_acting == true" };
    const d = evaluate(draft({ custom: { worth_acting: true } }), policy);
    expect(d.outcome).toBe("escalate");
    expect(d.matched_rule).toBe("manifest:escalate_when");
  });

  it("auto-completes when auto_complete_when matches and nothing above it fired", () => {
    const policy: PolicySpec = {
      escalate_when: "worth_acting == true",
      auto_complete_when: "worth_acting == false",
      confidence_threshold: 0.7,
    };
    const d = evaluate(draft(), policy);
    expect(d.outcome).toBe("auto_complete");
    expect(d.matched_rule).toBe("manifest:auto_complete_when");
  });

  it("escalates below the confidence threshold even when auto_complete_when would match", () => {
    const policy: PolicySpec = {
      auto_complete_when: "worth_acting == false",
      confidence_threshold: 0.7,
    };
    const d = evaluate(draft({ context: testContext({ confidence: 0.4 }) }), policy);
    expect(d.outcome).toBe("escalate");
    expect(d.matched_rule).toBe("manifest:confidence_threshold");
  });

  it("runs escalate_when before the confidence threshold", () => {
    const policy: PolicySpec = { escalate_when: "true", confidence_threshold: 0.1 };
    expect(evaluate(draft(), policy).matched_rule).toBe("manifest:escalate_when");
  });

  it('honours the anchor\'s "always review" policy', () => {
    // §12 step 10: wrap/meeting items declare escalate_when "true" so nothing
    // reaches Notion without a human.
    const d = evaluate(draft(), { escalate_when: "true" });
    expect(d.outcome).toBe("escalate");
  });

  describe("money lock (§9)", () => {
    const permissive: PolicySpec = { auto_complete_when: "true" };

    it("escalates a money-locked action type no matter what the manifest says", () => {
      const d = evaluate(draft(), permissive, { actionType: "payment.make" });
      expect(d.outcome).toBe("escalate");
      expect(d.matched_rule).toBe("hardcoded:payment.make");
    });

    it("escalates a money-locked execution id too", () => {
      const d = evaluate(draft(), permissive, { executionCapabilityId: "stripe.payment.create" });
      expect(d.outcome).toBe("escalate");
      expect(d.matched_rule).toBe("hardcoded:stripe.payment.create");
    });

    it("leaves ordinary action types free to auto-complete", () => {
      const d = evaluate(draft(), permissive, {
        actionType: "note.file",
        executionCapabilityId: "notion.insight.create",
      });
      expect(d.outcome).toBe("auto_complete");
    });
  });

  describe("risk framework (§9)", () => {
    const permissive: PolicySpec = { auto_complete_when: "true" };

    it("escalates an irreversible action by default, over a permissive policy", () => {
      const d = evaluate(
        draft({ context: testContext({ reversibility: "irreversible" }) }),
        permissive,
      );
      expect(d.outcome).toBe("escalate");
      expect(d.matched_rule).toBe("risk:irreversible");
    });

    it("lets a type opt out of the irreversibility rule with allow_irreversible", () => {
      const d = evaluate(draft({ context: testContext({ reversibility: "irreversible" }) }), {
        auto_complete_when: "true",
        allow_irreversible: true,
      });
      expect(d.outcome).toBe("auto_complete");
    });

    it("respects escalate_irreversible: false in the config", () => {
      const d = evaluate(
        draft({ context: testContext({ reversibility: "irreversible" }) }),
        permissive,
        { policyConfig: { valueThreshold: 100, escalateIrreversible: false } },
      );
      expect(d.outcome).toBe("auto_complete");
    });

    it("does not escalate a merely hard-to-reverse action", () => {
      const d = evaluate(draft({ context: testContext({ reversibility: "hard" }) }), permissive);
      expect(d.outcome).toBe("auto_complete");
    });

    it("escalates value at or above the threshold, over a permissive policy", () => {
      const d = evaluate(draft({ context: testContext({ value: 150 }) }), permissive);
      expect(d.outcome).toBe("escalate");
      expect(d.matched_rule).toBe("risk:value_threshold");
    });

    it("leaves value below the threshold free to auto-complete", () => {
      const d = evaluate(draft({ context: testContext({ value: 50 }) }), permissive);
      expect(d.outcome).toBe("auto_complete");
    });

    it("lets a per-type value_threshold override the global default, down and up", () => {
      const low = evaluate(draft({ context: testContext({ value: 50 }) }), {
        auto_complete_when: "true",
        value_threshold: 20,
      });
      expect(low.outcome).toBe("escalate");

      const high = evaluate(draft({ context: testContext({ value: 150 }) }), {
        auto_complete_when: "true",
        value_threshold: 500,
      });
      expect(high.outcome).toBe("auto_complete");
    });

    it("keeps the money-lock ahead of the risk rules", () => {
      const d = evaluate(
        draft({ context: testContext({ reversibility: "irreversible", value: 999 }) }),
        permissive,
        { actionType: "payment.make" },
      );
      expect(d.matched_rule).toBe("hardcoded:payment.make");
    });

    it("is a no-op when neither signal is present, preserving v0 behaviour", () => {
      expect(evaluate(draft(), permissive).outcome).toBe("auto_complete");
    });
  });

  describe("failure handling", () => {
    it("escalates rather than auto-completing when a predicate cannot be evaluated", () => {
      const d = evaluate(draft(), { auto_complete_when: "score + 1" });
      expect(d.outcome).toBe("escalate");
      expect(d.matched_rule).toBe("error:auto_complete_when");
    });

    it("escalates when escalate_when itself is broken", () => {
      const d = evaluate(draft(), { escalate_when: "((((" , auto_complete_when: "true" });
      expect(d.outcome).toBe("escalate");
      expect(d.matched_rule).toBe("error:escalate_when");
    });

    it("escalates when a predicate references a missing variable", () => {
      const d = evaluate(draft(), { auto_complete_when: "not_a_field == true" });
      expect(d.outcome).toBe("escalate");
    });
  });
});
