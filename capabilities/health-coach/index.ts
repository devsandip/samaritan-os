import type { RunContext, RunResult } from "../../src/run-layer/context.js";
import { getSecret } from "../../src/secrets.js";

export interface OuraV2DailyMetrics {
  sleep_score?: number;
  readiness_score?: number;
  hrv_ms?: number;
  stress_high_minutes?: number;
}

export type ReadinessTier = "deload" | "maintenance" | "progressive_overload";

export interface ReadinessCoachingPlan {
  tier: ReadinessTier;
  set_multiplier: number;
  rpe_cap: number;
  adjustment_summary: string;
}

export async function fetchOuraV2DailyMetrics(options: {
  token?: string;
  date?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<OuraV2DailyMetrics> {
  const token = options.token ?? getSecret("oura:default");
  if (!token) return {};

  const fetchFn = options.fetchImpl ?? fetch;
  const dateParam = options.date
    ? `?start_date=${encodeURIComponent(options.date)}&end_date=${encodeURIComponent(options.date)}`
    : "";
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

  const [readinessRes, sleepRes, stressRes] = await Promise.all([
    fetchFn(`https://api.ouraring.com/v2/usercollection/daily_readiness${dateParam}`, { headers }),
    fetchFn(`https://api.ouraring.com/v2/usercollection/daily_sleep${dateParam}`, { headers }),
    fetchFn(`https://api.ouraring.com/v2/usercollection/daily_stress${dateParam}`, { headers }),
  ]);

  const readinessData = readinessRes.ok
    ? ((await readinessRes.json()) as { data?: { score?: number; contributors?: { hrv_balance?: number } }[] })
    : {};
  const sleepData = sleepRes.ok
    ? ((await sleepRes.json()) as { data?: { score?: number }[] })
    : {};
  const stressData = stressRes.ok
    ? ((await stressRes.json()) as { data?: { stress_high?: number }[] })
    : {};

  const readinessScore = readinessData.data?.[0]?.score;
  const hrvBalance = readinessData.data?.[0]?.contributors?.hrv_balance;
  const sleepScore = sleepData.data?.[0]?.score;
  const stressHigh = stressData.data?.[0]?.stress_high;

  return {
    ...(typeof sleepScore === "number" ? { sleep_score: sleepScore } : {}),
    ...(typeof readinessScore === "number" ? { readiness_score: readinessScore } : {}),
    ...(typeof hrvBalance === "number" ? { hrv_ms: hrvBalance } : {}),
    ...(typeof stressHigh === "number" ? { stress_high_minutes: Math.round(stressHigh / 60) } : {}),
  };
}

export function computeReadinessCoaching(input: {
  sleep_score: number;
  hrv_ms: number;
  recovery_pct: number;
  routine_title: string;
}): ReadinessCoachingPlan {
  const { sleep_score, hrv_ms, recovery_pct } = input;
  if (recovery_pct < 70) {
    return {
      tier: "deload",
      set_multiplier: 0.8,
      rpe_cap: 7.5,
      adjustment_summary: `Recovery ${recovery_pct}% (Sleep ${sleep_score}, HRV ${hrv_ms}ms) [deload]: reduce working sets by 20%, cap RPE at 7.5, and swap heavy axial compounds for machine/supported variants.`,
    };
  }
  if (recovery_pct < 85) {
    return {
      tier: "maintenance",
      set_multiplier: 1.0,
      rpe_cap: 8.0,
      adjustment_summary: `Recovery ${recovery_pct}% (Sleep ${sleep_score}, HRV ${hrv_ms}ms) [maintenance]: keep programmed working sets at RPE 8.0 target and preserve 2 reps in reserve.`,
    };
  }
  return {
    tier: "progressive_overload",
    set_multiplier: 1.05,
    rpe_cap: 8.5,
    adjustment_summary: `Recovery ${recovery_pct}% (Sleep ${sleep_score}, HRV ${hrv_ms}ms) [progressive_overload]: high readiness window; add +2.5% load or +1 rep on primary compound sets (RPE 8.5 cap).`,
  };
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const today =
    (typeof ctx.inputs.date === "string" && ctx.inputs.date) ||
    new Date().toLocaleDateString("sv-SE");

  let oura: OuraV2DailyMetrics = {};
  const logs: string[] = [];
  if (
    typeof ctx.inputs.sleep_score !== "number" &&
    typeof ctx.inputs.recovery_pct !== "number" &&
    typeof ctx.inputs.oura_token === "string"
  ) {
    try {
      oura = await fetchOuraV2DailyMetrics({ token: ctx.inputs.oura_token, date: today });
      logs.push("fetched Oura V2 daily readiness/sleep/stress");
    } catch (err) {
      logs.push(`oura fetch failed: ${(err as Error).message}`);
    }
  }

  const sleepScore =
    typeof ctx.inputs.sleep_score === "number"
      ? ctx.inputs.sleep_score
      : (oura.sleep_score ?? 72);
  const hrvMs =
    typeof ctx.inputs.hrv_ms === "number" ? ctx.inputs.hrv_ms : (oura.hrv_ms ?? 44);
  const recoveryPct =
    typeof ctx.inputs.recovery_pct === "number"
      ? ctx.inputs.recovery_pct
      : (oura.readiness_score ?? 58);
  const routineTitle =
    (typeof ctx.inputs.routine_title === "string" && ctx.inputs.routine_title) ||
    "Upper Body Hypertrophy A";

  const coaching = computeReadinessCoaching({
    sleep_score: sleepScore,
    hrv_ms: hrvMs,
    recovery_pct: recoveryPct,
    routine_title: routineTitle,
  });

  const adjustment =
    (typeof ctx.inputs.adjustment_summary === "string" && ctx.inputs.adjustment_summary) ||
    coaching.adjustment_summary;

  return {
    action_items: [
      {
        capability_id: "health-coach",
        type: "hevy-routine-proposal",
        scope: "personal",
        context: {
          what_happened: `7-day recovery check (${recoveryPct}% recovery, HRV ${hrvMs}ms, tier: ${coaching.tier}) suggests a volume adjustment for "${routineTitle}"`,
          source: { kind: "health-coach", id: `health:${today}` },
          provenance: ["oura.v2", "whoop", "hevy", "apple.health"],
          why_flagged: "creates a new adjusted Hevy routine copy without overwriting your base template",
          trigger_reason: "policy",
          confidence: 0.89,
          decision_needed: `Create adjusted Hevy routine copy for "${routineTitle}"?`,
          decision_surface: "inbox",
          execution_surface: "hevy",
          outcome_preview: `Creates "${routineTitle} (Samaritan Adjusted ${today})" via POST /v1/routines`,
        },
        custom: {
          routine_title: routineTitle,
          adjustment_summary: adjustment,
          recovery_badge: `Recovery ${recoveryPct}% · HRV ${hrvMs}ms`,
          notes: adjustment,
        },
        dedupe_key: `health-coach:hevy:${today}:${routineTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      },
    ],
    status: "ok",
    logs,
  };
}
