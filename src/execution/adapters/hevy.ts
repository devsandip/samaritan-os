/**
 * Hevy Routine Copy adapter (PROPOSAL-v1 Phase 3, P3-8).
 *
 * Implements `hevy.routine.copy` against `https://api.hevyapp.com/v1/routines`.
 * Guardrail: never calls `PUT /v1/routines/:id` to overwrite an existing routine.
 * Always creates a new routine copy suffixed with `(Samaritan Adjusted YYYY-MM-DD)`.
 */
import { getSecret } from "../../secrets.js";
import type {
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "../../types/index.js";
import { renderPayload } from "./guided.js";

function localDateIso(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const HEVY_API = "https://api.hevyapp.com/v1";

export interface HevyAdapterOptions {
  apiKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export function createHevyRoutineCopyAdapter(
  options: HevyAdapterOptions = {},
): ExecutionAdapter {
  const resolveKey = options.apiKey ?? (() => getSecret("hevy:api"));
  const fetchFn = options.fetchImpl ?? fetch;

  return {
    id: "hevy.routine.copy",
    provider: "hevy",
    description:
      "Creates an adjusted copy of a Hevy workout routine via POST /v1/routines without overwriting the original routine.",
    modes: ["assisted", "automated", "guided"],

    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      const payload = request.payload as {
        routine_title?: string;
        title?: string;
        adjustment_summary?: string;
        exercises?: unknown[];
        notes?: string;
      };

      const baseTitle = (payload.routine_title ?? payload.title ?? "Workout Routine").trim();
      const copyTitle = `${baseTitle} (Samaritan Adjusted ${localDateIso()})`;
      const summary = (payload.adjustment_summary ?? payload.notes ?? "Adjusted volume/deload").trim();
      const apiKey = resolveKey();

      if (request.mode === "guided" || !apiKey) {
        return {
          status: "staged",
          guided_instructions: renderPayload({
            new_routine_title: copyTitle,
            adjustment_summary: summary,
          }),
          guided_link: "https://hevy.com",
          result: { staged_routine_title: copyTitle },
        };
      }

      try {
        const response = await fetchFn(`${HEVY_API}/routines`, {
          method: "POST",
          headers: {
            "api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            routine: {
              title: copyTitle,
              notes: summary,
              exercises: Array.isArray(payload.exercises) ? payload.exercises : [],
            },
          }),
        });

        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          return {
            status: "failed",
            error: `hevy ${response.status}: ${String(data["error"] ?? data["message"] ?? response.statusText)}`,
          };
        }

        const routineObj =
          (Array.isArray(data["routine"]) ? data["routine"][0] : data["routine"]) as
            | Record<string, unknown>
            | undefined;
        const routineId =
          (typeof routineObj?.["id"] === "string" && routineObj["id"]) ||
          (typeof data["id"] === "string" && data["id"]) ||
          `hevy-copy-${Date.now()}`;

        if (request.mode === "assisted") {
          return {
            status: "staged",
            guided_instructions: `Created Hevy routine copy "${copyTitle}" (${routineId}). Confirm once reviewed in Hevy.`,
            guided_link: "https://hevy.com",
            result: { hevy_routine_id: routineId, title: copyTitle },
          };
        }

        return {
          status: "succeeded",
          result: {
            hevy_routine_id: routineId,
            title: copyTitle,
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
