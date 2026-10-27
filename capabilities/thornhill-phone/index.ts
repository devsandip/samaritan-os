import type { RunContext, RunResult } from "../../src/run-layer/context.js";
import type { DraftActionItem } from "../../src/types/index.js";

export async function run(ctx: RunContext): Promise<RunResult> {
  const payload = { ...ctx.inputs, ...((ctx.trigger.payload ?? {}) as Record<string, unknown>) };
  const items: DraftActionItem[] = [];

  if (
    payload.event_type === "phone.stop_point_reached" ||
    (payload.stop_point_alert && typeof payload.stop_point_alert === "object")
  ) {
    const alert = (payload.stop_point_alert as Record<string, unknown> | undefined) ?? payload;
    const callId = String(alert.call_id ?? "call-active");
    const callee = String(alert.callee_name ?? "Service Representative");
    const phone = String(alert.phone_number ?? "+1-800-555-0100");
    const stopReason = String(alert.stop_reason ?? "payment_or_otp");
    const question = String(
      alert.question ??
        "Agent reached a stop-point requiring verification code or payment confirmation.",
    );

    items.push({
      capability_id: "thornhill-phone",
      type: "phone-stop-point-alert",
      scope: "personal",
      context: {
        what_happened: `Thornhill call ${callId} to ${callee} paused at stop-point (${stopReason})`,
        source: { kind: "thornhill", id: `stop:${callId}:${stopReason}` },
        provenance: ["thornhill.webhook"],
        why_flagged: "Thornhill never crosses payment, OTP, or legal commitment boundaries without human instruction",
        trigger_reason: "policy",
        confidence: 0.99,
        reversible: false,
        decision_needed: `${callee}: ${question}`,
        decision_surface: "inbox",
        execution_surface: "thornhill",
        outcome_preview: `Delivers your instruction or terminates call ${callId}`,
      },
      custom: {
        call_id: callId,
        callee_name: callee,
        phone_number: phone,
        stop_reason: stopReason,
        question,
      },
      dedupe_key: `thornhill:stop:${callId}:${stopReason}`,
    });
  }

  const calleeName = typeof payload.callee_name === "string" ? payload.callee_name : "";
  const phoneNumber = typeof payload.phone_number === "string" ? payload.phone_number : "";
  const callObjective = typeof payload.call_objective === "string" ? payload.call_objective : "";

  if (calleeName && phoneNumber && callObjective) {
    const stopPoints =
      typeof payload.stop_points === "string" && payload.stop_points
        ? payload.stop_points
        : "Stop and escalate before any payment, OTP, legal commitment, or reschedule outside approved window";

    items.push({
      capability_id: "thornhill-phone",
      type: "phone-call-proposal",
      scope: "personal",
      context: {
        what_happened: `Outbound phone task requested: call ${calleeName} (${phoneNumber})`,
        source: { kind: "thornhill", id: `call:${phoneNumber}` },
        provenance: ["thornhill.request"],
        why_flagged: "outbound voice calls are assisted-only and require explicit human approval before dialing",
        trigger_reason: "policy",
        confidence: 0.92,
        reversible: false,
        decision_needed: `Approve Thornhill outbound call to ${calleeName} (${phoneNumber})?`,
        decision_surface: "inbox",
        execution_surface: "thornhill",
        outcome_preview: `Dials ${phoneNumber} via Thornhill with stop-points (${stopPoints})`,
      },
      custom: {
        callee_name: calleeName,
        phone_number: phoneNumber,
        call_objective: callObjective,
        stop_points: stopPoints,
      },
      dedupe_key: `thornhill:call:${phoneNumber}:${callObjective.slice(0, 32).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    });
  }

  return { action_items: items, status: "ok", logs: [] };
}
