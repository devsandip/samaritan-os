/**
 * The batch-eligibility gate (TECH-SPEC §9, §12 step 23).
 *
 * These prove the pure rule in isolation: what may ride along in a batch and
 * what must be pulled out for individual review. The wiring test
 * (action-center-batch) proves the ActionCenter actually consults it.
 */
import { describe, expect, it } from "vitest";
import { assessBatchRisk } from "../src/action-center/risk.js";
import { DEFAULT_POLICY_CONFIG } from "../src/policy/index.js";

const config = DEFAULT_POLICY_CONFIG; // { valueThreshold: 100, escalateIrreversible: true }

describe("assessBatchRisk (§9)", () => {
  it("waves through an item with no risk signals", () => {
    expect(assessBatchRisk({ config })).toEqual({ batchable: true });
  });

  it("refuses money by action type, and no override can bend it", () => {
    const risk = assessBatchRisk({
      actionType: "payment.make",
      policy: { allow_irreversible: true, value_threshold: 1_000_000 },
      config,
    });
    expect(risk.batchable).toBe(false);
    expect(risk).toMatchObject({ rule: "risk:money" });
  });

  it("refuses money by execution-registry id namespace", () => {
    const risk = assessBatchRisk({ executionCapabilityId: "stripe.payment.create", config });
    expect(risk).toMatchObject({ batchable: false, rule: "risk:money" });
  });

  it("refuses an irreversible item by default", () => {
    const risk = assessBatchRisk({ reversibility: "irreversible", config });
    expect(risk).toMatchObject({ batchable: false, rule: "risk:irreversible" });
  });

  it("lets an irreversible item batch when its type opts out", () => {
    const risk = assessBatchRisk({
      reversibility: "irreversible",
      policy: { allow_irreversible: true },
      config,
    });
    expect(risk).toEqual({ batchable: true });
  });

  it("lets an irreversible item batch when the global toggle is off", () => {
    const risk = assessBatchRisk({
      reversibility: "irreversible",
      config: { valueThreshold: 100, escalateIrreversible: false },
    });
    expect(risk).toEqual({ batchable: true });
  });

  it("treats 'hard' (not irreversible) as batchable", () => {
    expect(assessBatchRisk({ reversibility: "hard", config })).toEqual({ batchable: true });
  });

  it("refuses value at or above the global threshold", () => {
    const risk = assessBatchRisk({ value: 100, config });
    expect(risk).toMatchObject({ batchable: false, rule: "risk:value_threshold" });
  });

  it("batches value below the threshold", () => {
    expect(assessBatchRisk({ value: 99, config })).toEqual({ batchable: true });
  });

  it("honours a per-type value_threshold override", () => {
    // Global default is 100; a type that sets 10 pulls a value-20 item out.
    const risk = assessBatchRisk({ value: 20, policy: { value_threshold: 10 }, config });
    expect(risk).toMatchObject({ batchable: false, rule: "risk:value_threshold" });
  });

  it("money wins over irreversible and value (precedence)", () => {
    const risk = assessBatchRisk({
      actionType: "transfer.send",
      reversibility: "irreversible",
      value: 5000,
      config,
    });
    expect(risk).toMatchObject({ rule: "risk:money" });
  });
});
