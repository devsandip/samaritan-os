/**
 * Routing Config (TECH-SPEC §4.3) and the resolver's return shape (§5.4).
 *
 * Routing is the only translation from an abstract action type ("email.send")
 * to a concrete provider/account/mode ("gmail" on "sandip@work", assisted).
 */
import { z } from "zod";
import { ExecutionCapabilityId, ExecutionMode } from "./common.js";

export const RoutingEntry = z.object({
  /** Abstract action, e.g. "email.send". */
  action_type: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:\.[a-z0-9_]+)+$/, "must be a dotted action type like email.send"),
  provider: z.string().min(1),
  account: z.string().min(1),
  mode: ExecutionMode,
  fallback_provider: z.string().min(1).optional(),
  /** Cannot be promoted past this mode via the API. PUT returns 409 (§9). */
  locked: z.boolean().default(false),
});
export type RoutingEntry = z.infer<typeof RoutingEntry>;

export const RoutingFile = z.array(RoutingEntry);
export type RoutingFile = z.infer<typeof RoutingFile>;

export const RoutingResolution = z.object({
  provider: z.string(),
  account: z.string(),
  mode: ExecutionMode,
  locked: z.boolean(),
  /** The concrete Execution Registry id to call. */
  execution_capability_id: ExecutionCapabilityId,
});
export type RoutingResolution = z.infer<typeof RoutingResolution>;
