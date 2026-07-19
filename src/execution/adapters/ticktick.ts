/**
 * TickTick adapter (TECH-SPEC §12 step 8).
 *
 * TickTick has no official Node SDK and its Open API is OAuth-only, with no
 * long-lived token to drop in the Keychain. Until that flow is built, this
 * adapter declares `guided` only: it renders the task as copy-ready text and
 * reports "staged", so the item waits in `awaiting_confirmation` until Sandip
 * confirms he made it.
 *
 * That is a deliberate use of §1's rule that every action type must have a
 * working guided path before it is promoted. The manifest can keep declaring
 * `automated`; §10 degrades it here and restores it automatically once an
 * automated-capable adapter registers under the same id.
 */
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from "../../types/index.js";
import { renderPayload } from "./guided.js";

export const tickTickTaskCreate: ExecutionAdapter = {
  id: "ticktick.task.create",
  provider: "ticktick",
  description: "Stages a TickTick task as copy-ready text (OAuth flow not built yet)",
  modes: ["guided"],

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const { title, due, list } = request.payload as {
      title?: string;
      due?: string;
      list?: string;
    };
    if (!title) return { status: "failed", error: 'payload requires a "title"' };

    return {
      status: "staged",
      guided_instructions: renderPayload({
        task: title,
        ...(due ? { due } : {}),
        ...(list ? { list } : {}),
      }),
      guided_link: "ticktick://",
      result: { staged_task: title },
    };
  },

  async verify() {
    return "not_configured";
  },
};
