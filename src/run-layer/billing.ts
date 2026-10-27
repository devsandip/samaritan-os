/**
 * C2 Billing Guardrails: Monthly Spend Cap, Per-Run Cost Tracking, and
 * Unchanged-Input Skipping (PROPOSAL-v1 C2).
 *
 * Interactive work stays on the Claude plan; unattended daemon runs use a
 * Console API key with a hard monthly cap (`monthly_cap_usd`) and skip model
 * calls when canonical inputs have not changed since the last succeeded run.
 */
import { createHash } from "node:crypto";
import type { Db } from "../store/db.js";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function computeInputHash(inputs: unknown): string {
  const digest = createHash("sha256").update(canonicalize(inputs ?? {})).digest("hex");
  return `sha256:${digest}`;
}

export function getMonthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString();
}

export function getMonthToDateSpendUsd(db: Db, now: Date = new Date()): number {
  const monthStart = getMonthStartIso(now);
  const row = db
    .prepare<{ total: number | null }>(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE started_at >= ?",
    )
    .get(monthStart);
  return Number(row?.total ?? 0);
}

export function checkBillingAllowance(
  db: Db,
  monthlyCapUsd: number,
  now: Date = new Date(),
): { allowed: boolean; mtd_spend_usd: number; monthly_cap_usd: number } {
  const mtd = getMonthToDateSpendUsd(db, now);
  return {
    allowed: mtd < monthlyCapUsd,
    mtd_spend_usd: mtd,
    monthly_cap_usd: monthlyCapUsd,
  };
}

/**
 * Returns true if the most recent succeeded run for `capabilityId` had the
 * exact same `inputHash`, allowing the Run Layer to skip redundant work.
 */
export function hasUnchangedInputSucceeded(
  db: Db,
  capabilityId: string,
  inputHash: string,
): boolean {
  const row = db
    .prepare<{ input_hash: string | null }>(
      `SELECT input_hash
         FROM runs
        WHERE capability_id = ? AND status = 'succeeded'
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(capabilityId);
  return row?.input_hash === inputHash;
}
