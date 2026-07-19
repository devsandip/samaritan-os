/**
 * Policy Engine (TECH-SPEC §5.6, §12 step 7).
 *
 * A pure decision function: given a draft action item and its type's policy
 * spec, return `auto_complete` or `escalate` with a reason and the rule that
 * matched. No side effects, no I/O, no store access. That makes it trivially
 * unit-testable and means the decision to skip Sandip can be reasoned about in
 * isolation from everything downstream, which is the one place in the system
 * where being wrong is most expensive.
 */
import { isMoneyLocked, isMoneyLockedExecutionId } from "../guardrails.js";
import { contextVariables, type DraftActionItem, type PolicySpec } from "../types/index.js";
import { compilePredicate, PredicateError } from "./predicate.js";

export { compilePredicate, PredicateError } from "./predicate.js";
export type { CompiledPredicate } from "./predicate.js";

export interface PolicyDecision {
  outcome: "auto_complete" | "escalate";
  reason: string;
  /** e.g. "hardcoded:payment.make" | "manifest:confidence_threshold" */
  matched_rule: string;
}

export interface EvaluateOptions {
  /** The manifest's execution target, e.g. "notion.insight.create". */
  executionCapabilityId?: string;
  /** The abstract action type, when routing has already resolved one. */
  actionType?: string;
}

/**
 * The flat, read-only variable map a predicate is evaluated against: the item's
 * context fields merged with all of its declared custom attributes (§5.6).
 * Shadowing is impossible because the manifest schema rejects it at load time.
 */
export function variableScope(draft: DraftActionItem): Record<string, unknown> {
  return { ...contextVariables(draft.context), ...draft.custom };
}

/** Variable names a predicate for this action-item type is allowed to reference. */
export function allowedVariables(customAttributeNames: readonly string[]): string[] {
  return [...contextVariableNames(), ...customAttributeNames];
}

function contextVariableNames(): string[] {
  // Derived from a representative context so the list can never drift from the
  // shape contextVariables() actually produces.
  return Object.keys(
    contextVariables({
      what_happened: "",
      source: { kind: "", id: "" },
      provenance: [],
      why_flagged: "",
      trigger_reason: "policy",
      confidence: 0,
      decision_needed: "",
      decision_surface: "",
      execution_surface: "",
      outcome_preview: "",
    }),
  );
}

export function evaluate(
  draft: DraftActionItem,
  policy: PolicySpec | undefined,
  opts: EvaluateOptions = {},
): PolicyDecision {
  // 1. The money-lock (§9). Checked first, and no manifest can override it.
  const lockedSubject =
    opts.actionType && isMoneyLocked(opts.actionType)
      ? opts.actionType
      : opts.executionCapabilityId && isMoneyLockedExecutionId(opts.executionCapabilityId)
        ? opts.executionCapabilityId
        : undefined;
  if (lockedSubject) {
    return {
      outcome: "escalate",
      reason: `"${lockedSubject}" is money-locked: money never moves without an explicit approval.`,
      matched_rule: `hardcoded:${lockedSubject}`,
    };
  }

  const scope = variableScope(draft);

  // A predicate that cannot be evaluated fails closed. Escalating a low-risk
  // item costs Sandip ten seconds; auto-completing something we failed to
  // reason about costs trust.
  const test = (expression: string, rule: string): boolean | PolicyDecision => {
    try {
      return compilePredicate(expression).evaluate(scope);
    } catch (err) {
      const detail = err instanceof PredicateError ? err.message : String(err);
      return {
        outcome: "escalate",
        reason: `Policy predicate could not be evaluated, so this was escalated rather than assumed safe. ${detail}`,
        matched_rule: `error:${rule}`,
      };
    }
  };

  // 2. escalate_when.
  if (policy?.escalate_when) {
    const result = test(policy.escalate_when, "escalate_when");
    if (typeof result !== "boolean") return result;
    if (result) {
      return {
        outcome: "escalate",
        reason: `escalate_when matched: ${policy.escalate_when}`,
        matched_rule: "manifest:escalate_when",
      };
    }
  }

  // 3. confidence_threshold.
  if (policy?.confidence_threshold !== undefined) {
    const confidence = draft.context.confidence;
    if (confidence < policy.confidence_threshold) {
      return {
        outcome: "escalate",
        reason: `confidence ${confidence} is below the ${policy.confidence_threshold} threshold`,
        matched_rule: "manifest:confidence_threshold",
      };
    }
  }

  // 4. auto_complete_when.
  if (policy?.auto_complete_when) {
    const result = test(policy.auto_complete_when, "auto_complete_when");
    if (typeof result !== "boolean") return result;
    if (result) {
      return {
        outcome: "auto_complete",
        reason: `auto_complete_when matched: ${policy.auto_complete_when}`,
        matched_rule: "manifest:auto_complete_when",
      };
    }
  }

  // 5. Default. Nothing claimed this item as safe, so a human sees it.
  return {
    outcome: "escalate",
    reason: "no policy rule matched; escalating by default",
    matched_rule: "default:escalate",
  };
}
