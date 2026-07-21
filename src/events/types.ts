/**
 * The one internal event shape (TECH-SPEC §2.2, §12 step 18).
 *
 * Listeners — a Gmail poller, a Fireflies webhook, a chokidar watch on the vault
 * — each normalise their heterogeneous input into this, and the Event Bus is the
 * only thing downstream of them. A capability never sees a Gmail API payload or a
 * filesystem event; it sees a `SamaritanEvent` and, through the Run Layer, its
 * `payload`.
 *
 * `id` is load-bearing: it is the stable source id the bus dedups on, so the
 * same underlying message delivered by both a webhook and a poll fires a
 * capability once. Listeners namespace it ("gmail:<msgid>", "file:<path>@<mtime>")
 * so two sources cannot collide on a bare integer.
 */
import { z } from "zod";

export const SamaritanEvent = z.object({
  /** Dotted event type a manifest subscribes to, e.g. "email.received". */
  type: z
    .string()
    .regex(/^[a-z0-9]+(?:\.[a-z0-9_]+)+$/, "must be a dotted event type like email.received"),
  /** Stable source id, namespaced by the listener. The dedup key. */
  id: z.string().min(1),
  /** The normalised data the capability reads via `context.trigger.payload`. */
  payload: z.record(z.string(), z.unknown()).default({}),
  /** When the underlying thing happened, ISO 8601. Defaults to receipt time. */
  occurred_at: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 datetime")
    .optional(),
  /** Which listener produced it ("gmail", "filesystem", …). Informational. */
  source: z.string().min(1).optional(),
});
export type SamaritanEvent = z.infer<typeof SamaritanEvent>;
