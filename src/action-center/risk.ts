/**
 * Batch-eligibility risk gate (TECH-SPEC §5.6, §9, §12 step 23).
 *
 * Batch-approve is one decision applied to many similar items. That convenience
 * is only safe when each item's individual stakes are low, so a *committing*
 * batch response — one whose outcome executes or dispatches — is gated here to
 * the same three risk dimensions the Policy Engine escalates on: money,
 * irreversibility, value. A non-committing response (discard, defer) is never
 * gated, because it commits nothing to the world and so cannot be got wrong in
 * bulk.
 *
 * This deliberately mirrors evaluate()'s risk rules (money → irreversible →
 * value) but not its predicate rules (escalate_when / confidence /
 * auto_complete_when). Every batched item is already `pending`, so the question
 * is not "should this have been escalated" — it was — but "is this item's stake
 * low enough to wave through alongside its neighbours, or does it deserve a look
 * on its own". Money is absolute here as everywhere; reversibility and value
 * honour the same per-type overrides the engine does.
 */
import { isMoneyLocked, isMoneyLockedExecutionId } from "../guardrails.js";
import type { PolicyConfig } from "../policy/index.js";

export interface BatchRiskInput {
  /** The manifest's abstract action type, e.g. "payment.make". */
  actionType?: string;
  /** The execution-registry id, e.g. "stripe.payment.create". */
  executionCapabilityId?: string;
  /** The item's stated reversibility; absent is treated as reversible. */
  reversibility?: "reversible" | "hard" | "irreversible";
  /** The item's stated value/magnitude; absent is treated as zero. */
  value?: number;
  /** Per-type overrides from the manifest's policy spec (§9). */
  policy?: { allow_irreversible?: boolean; value_threshold?: number };
  /** Global risk thresholds (config.policy). */
  config: PolicyConfig;
}

export type BatchRisk =
  | { batchable: true }
  | { batchable: false; reason: string; rule: string };

/**
 * Decides whether a committing response may be applied to this item as part of a
 * batch. Non-committing responses skip this call entirely.
 */
export function assessBatchRisk(input: BatchRiskInput): BatchRisk {
  // Money is absolute, exactly as in the Policy Engine and everywhere else: it
  // never moves in a bulk action, no override, no exception.
  if (
    (input.actionType && isMoneyLocked(input.actionType)) ||
    (input.executionCapabilityId && isMoneyLockedExecutionId(input.executionCapabilityId))
  ) {
    return {
      batchable: false,
      reason: "money never moves in a batch — approve it on its own",
      rule: "risk:money",
    };
  }

  // Irreversibility is a strong default with a per-type escape hatch, mirroring
  // §9. Silence (an absent reversibility) is never read as a claim of safety.
  if (
    input.reversibility === "irreversible" &&
    input.config.escalateIrreversible &&
    !input.policy?.allow_irreversible
  ) {
    return {
      batchable: false,
      reason: "irreversible actions are reviewed one at a time",
      rule: "risk:irreversible",
    };
  }

  // Value at or above the threshold pulls the item out of the batch. A per-type
  // value_threshold overrides the global default; an absent value is zero.
  const threshold = input.policy?.value_threshold ?? input.config.valueThreshold;
  if (input.value !== undefined && input.value >= threshold) {
    return {
      batchable: false,
      reason: `value ${input.value} is at or above the ${threshold} threshold — review it on its own`,
      rule: "risk:value_threshold",
    };
  }

  return { batchable: true };
}
