/**
 * Execution Registry contracts (TECH-SPEC §4.4, §5.3).
 *
 * The registry is the catalogue of what the OS can actually do. Data shapes are
 * zod schemas; the adapter and registry surfaces carry functions, so they stay
 * plain TypeScript interfaces.
 */
import { z } from "zod";
import { ConnectionStatus, ExecutionCapabilityId, ExecutionMode, IsoDateTime } from "./common.js";

export const ExecutionCapability = z.object({
  /** e.g. "notion.insight.create" */
  id: ExecutionCapabilityId,
  provider: z.string().min(1),
  description: z.string().min(1),
  /** Which modes this adapter can actually perform. */
  modes_supported: z.array(ExecutionMode).min(1),
  /** Module path, e.g. "adapters/notion/insightCreate.ts". */
  adapter: z.string().min(1),
  scopes_required: z.array(z.string()).default([]),
  status: ConnectionStatus,
  account: z.string().optional(),
  last_verified_at: IsoDateTime.optional(),
});
export type ExecutionCapability = z.infer<typeof ExecutionCapability>;

export const ExecutionRequest = z.object({
  action_item_id: z.uuid(),
  capability: ExecutionCapabilityId,
  mode: ExecutionMode,
  payload: z.record(z.string(), z.unknown()),
  /**
   * Threaded to the adapter on every attempt, including retries. Adapters must
   * check-or-create by this key so a call that succeeded server-side but timed
   * out client-side is not executed twice (§10).
   */
  idempotency_key: z.string().min(1),
});
export type ExecutionRequest = z.infer<typeof ExecutionRequest>;

/**
 * `staged` means the OS has done its part but the real-world effect is not
 * committed yet: a guided deep link, or an assisted Gmail draft Sandip still has
 * to send. The Action Center maps it to `awaiting_confirmation` (§5.3).
 */
export const ExecutionResult = z.object({
  status: z.enum(["succeeded", "failed", "staged"]),
  result: z.record(z.string(), z.unknown()).optional(),
  /** Populated for guided and assisted handoffs. */
  guided_link: z.string().optional(),
  /** Human-readable copy-ready text for guided fallbacks. */
  guided_instructions: z.string().optional(),
  error: z.string().optional(),
});
export type ExecutionResult = z.infer<typeof ExecutionResult>;

export interface ExecutionAdapter {
  /** e.g. "notion.insight.create" */
  readonly id: string;
  readonly provider: string;
  readonly description: string;
  /** Which modes this adapter implements. */
  readonly modes: ExecutionMode[];
  readonly scopes_required?: string[];
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  /** Connection-health check surfaced in Settings. */
  verify?(): Promise<ConnectionStatus>;
}

export interface ExecutionRegistry {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  register(adapter: ExecutionAdapter): void;
  has(id: string): boolean;
  get(id: string): ExecutionAdapter | undefined;
  capabilities(): ExecutionCapability[];
}
