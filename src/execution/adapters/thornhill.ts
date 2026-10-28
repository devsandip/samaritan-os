/**
 * Thornhill Phone Executor adapter (PROPOSAL-v1 D7, Phase 4).
 *
 * Implements `phone.task.run` in `assisted` and `guided` modes.
 * Guardrails:
 * 1. Outbound phone calls are never `automated`; Sandip must explicitly approve
 *    the call objective and stop-point rules in the Inbox first.
 * 2. When Thornhill hits a stop-point mid-call (payment, OTP, legal commitment,
 *    or scheduling conflict), it posts to `/api/webhooks/thornhill`, which
 *    escalates a high-priority Inbox card + Telegram alert.
 */
import { loadConfig } from "../../config/index.js";
import { getSecret } from "../../secrets.js";
import type {
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "../../types/index.js";
import { renderPayload } from "./guided.js";

export interface ThornhillAdapterOptions {
  apiKey?: () => string | undefined;
  apiUrl?: () => string;
  fetchImpl?: typeof fetch;
}

export function createThornhillPhoneAdapter(
  options: ThornhillAdapterOptions = {},
): ExecutionAdapter {
  const resolveKey =
    options.apiKey ??
    (() => {
      const cfg = loadConfig();
      if (!cfg.thornhill.enabled) return undefined;
      return getSecret(`thornhill:${cfg.thornhill.account}`) ?? getSecret("thornhill:api");
    });
  const resolveUrl =
    options.apiUrl ?? (() => loadConfig().thornhill.url);
  const fetchFn = options.fetchImpl ?? fetch;

  return {
    id: "phone.task.run",
    provider: "thornhill",
    description:
      "Dispatches an approved outbound phone task to Thornhill in assisted mode with mandatory stop-point escalation.",
    modes: ["assisted", "guided"],

    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      const payload = request.payload as {
        callee_name?: string;
        phone_number?: string;
        call_objective?: string;
        stop_points?: string;
      };

      const callee = (payload.callee_name ?? "").trim();
      const phone = (payload.phone_number ?? "").trim();
      const objective = (payload.call_objective ?? "").trim();
      const stopPoints = (
        payload.stop_points ??
        "Stop and escalate before any payment, OTP entry, legal commitment, or non-standard time slot"
      ).trim();

      if (!phone || !objective) {
        return {
          status: "failed",
          error: 'payload requires "phone_number" and "call_objective"',
        };
      }

      const apiKey = resolveKey();
      if (request.mode === "guided" || !apiKey) {
        return {
          status: "staged",
          guided_instructions: renderPayload({
            callee_name: callee || "(callee)",
            phone_number: phone,
            call_objective: objective,
            stop_points: stopPoints,
          }),
          guided_link: `tel:${phone.replace(/[^0-9+]/g, "")}`,
          result: { staged_phone_call: phone, callee_name: callee },
        };
      }

      try {
        const baseUrl = resolveUrl().replace(/\/+$/g, "");
        const response = await fetchFn(`${baseUrl}/v1/calls`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            callee_name: callee,
            phone_number: phone,
            objective,
            stop_points: stopPoints,
            action_item_id: request.action_item_id,
          }),
        });

        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          return {
            status: "failed",
            error: `thornhill ${response.status}: ${String(data["error"] ?? data["message"] ?? response.statusText)}`,
          };
        }

        const callId =
          typeof data["call_id"] === "string"
            ? data["call_id"]
            : typeof data["id"] === "string"
              ? data["id"]
              : `thornhill-${Date.now()}`;

        return {
          status: "staged",
          guided_instructions: `Thornhill call ${callId} initiated to ${callee || phone}. Stop-points active (${stopPoints}). Confirm once call outcome is verified.`,
          result: {
            thornhill_call_id: callId,
            callee_name: callee,
            phone_number: phone,
          },
        };
      } catch (err) {
        return {
          status: "failed",
          error: (err as Error).message,
        };
      }
    },
  };
}
