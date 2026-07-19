/**
 * Generic guided fallback (TECH-SPEC §12 step 8).
 *
 * The human is the executor of last resort: §1 requires that every action type
 * have a working guided path before it is ever promoted, so nothing is allowed
 * to have no fallback. This adapter is that floor. It makes no external call,
 * renders the payload as copy-ready text, and reports "staged" so the item lands
 * in `awaiting_confirmation` until Sandip says he did it (§5.3).
 */
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from "../../types/index.js";

function renderValue(value: unknown, indent = ""): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => `${indent}- ${renderValue(v)}`).join("\n");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${indent}${k}: ${renderValue(v, `${indent}  `)}`)
      .join("\n");
  }
  return String(value);
}

export function renderPayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .map(([key, value]) => {
      const rendered = renderValue(value, "  ");
      return rendered.includes("\n") ? `${key}:\n${rendered}` : `${key}: ${rendered}`;
    })
    .join("\n");
}

export const guidedFallback: ExecutionAdapter = {
  id: "guided.fallback",
  provider: "none",
  description: "Renders an action as copy-ready text for Sandip to perform by hand",
  modes: ["guided"],

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const link = typeof request.payload["link"] === "string" ? request.payload["link"] : undefined;
    return {
      status: "staged",
      guided_instructions: renderPayload(request.payload),
      ...(link ? { guided_link: link } : {}),
      result: { rendered: true },
    };
  },

  async verify() {
    // Nothing to connect to, which is exactly why this is the floor.
    return "connected";
  },
};
