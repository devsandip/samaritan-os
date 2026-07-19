/**
 * The manifest catalogue: everything the render-schema system (UI-SPEC §4) needs
 * that does not travel on the item itself.
 *
 * An `ActionItem` carries `responses: string[]` (ids only), so the button label
 * and its `outcome` have to be looked up in the emitting capability's manifest.
 * `GET /api/capabilities` returns the manifest whole, including `emits[]`, which
 * is where `render`, `custom_attributes` and `responses[]` live. The per-type
 * effective mode arrives in a parallel `types[]` array keyed by the same type
 * name, so the two are joined here once rather than at every call site.
 */
import type {
  ActionItem,
  ActionItemTypeSpec,
  CapabilityManifest,
  ExecutionMode,
  RenderLayout,
  ResponseOutcome,
  ResponseSpec,
} from "../api/types";
import { titleCase } from "./format";

export interface ResolvedType {
  capability: CapabilityManifest;
  spec: ActionItemTypeSpec;
  /** What the type will actually run as, after §10's degrade-to-guided. */
  effectiveMode: ExecutionMode;
  degradedReason?: string;
}

export class Catalogue {
  private readonly byId = new Map<string, CapabilityManifest>();

  constructor(capabilities: CapabilityManifest[] = []) {
    for (const capability of capabilities) this.byId.set(capability.id, capability);
  }

  get all(): CapabilityManifest[] {
    return [...this.byId.values()];
  }

  capability(id: string): CapabilityManifest | undefined {
    return this.byId.get(id);
  }

  resolve(capabilityId: string, type: string): ResolvedType | undefined {
    const capability = this.byId.get(capabilityId);
    if (!capability) return undefined;
    const spec = capability.emits?.find((emit) => emit.type === type);
    if (!spec) return undefined;

    const status = capability.types?.find((t) => t.type === type);
    return {
      capability,
      spec,
      effectiveMode: status?.effective_mode ?? spec.execution.mode,
      ...(status?.degraded_reason ? { degradedReason: status.degraded_reason } : {}),
    };
  }

  resolveItem(item: ActionItem): ResolvedType | undefined {
    return this.resolve(item.capability_id, item.type);
  }

  /** Pending-item counts per capability, for the Dashboard agent grid (§5.1). */
  pendingByCapability(items: ActionItem[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item.capability_id, (counts.get(item.capability_id) ?? 0) + 1);
    }
    return counts;
  }
}

/**
 * §4.7: a missing or unrecognized layout must not drop the item. The header is
 * OS-contract data the Action Center owns, so it always renders; only the body
 * falls back.
 */
const LAYOUTS: RenderLayout[] = ["card", "form", "document", "diff"];

export function layoutFor(resolved: ResolvedType | undefined): RenderLayout | "raw" {
  const layout = resolved?.spec.render.layout;
  if (layout && LAYOUTS.includes(layout)) return layout;
  return "raw";
}

/**
 * Guesses an outcome for a response id whose manifest entry is gone.
 *
 * Only used to label the button and to explain why it is disabled. It never
 * changes what is sent: the server resolves the real outcome from its own copy
 * of the manifest, and refuses the response if it cannot.
 */
function inferOutcome(id: string): ResponseOutcome {
  if (/reject|discard|dismiss|decline|drop/i.test(id)) return "discard";
  if (/defer|snooze|later|remind/i.test(id)) return "defer";
  if (/ask|why|explain|more.?info/i.test(id)) return "ask_more_info";
  return "execute";
}

/**
 * Mirrors `DISMISS_RESPONSE_ID` in `src/types/common.ts`. Namespaced so it cannot
 * collide with a capability's own `dismiss`, which §4.6's worked example uses.
 */
export const DISMISS_RESPONSE_ID = "samaritan:dismiss";

/** A response as the button row needs it: the spec plus whether it can be sent. */
export interface ItemResponse extends ResponseSpec {
  /**
   * The daemon will accept this response. False means the manifest that declared
   * the id is not loaded, so the outcome above is a guess and sending it would
   * come back 409 — the button has to render, but it must not be pressable.
   */
  answerable: boolean;
}

/** §4.7's universal fallback. Accepted whatever the manifest says, or whether it exists. */
const DISMISS: ItemResponse = {
  id: DISMISS_RESPONSE_ID,
  label: "Dismiss",
  outcome: "discard",
  answerable: true,
};

/**
 * The item's allowed response ids joined to their manifest labels, in the order
 * the manifest declares (§4.6: `responses[]` renders 1:1, preserving order).
 *
 * An id with no manifest entry still renders, labelled by its id, so an item
 * whose capability was unloaded does not lose its button row and go silent about
 * what it used to offer. Those ids cannot be sent, which is what `Dismiss` is
 * for: §4.7 requires every item to have a way out of the Inbox, and without one
 * an orphaned item is stuck there permanently.
 */
export function responsesFor(item: ActionItem, resolved: ResolvedType | undefined): ItemResponse[] {
  const allowed = new Set(item.responses);
  const declared = resolved?.spec.responses ?? [];

  const known = declared
    .filter((response) => allowed.has(response.id))
    .map((response): ItemResponse => ({ ...response, answerable: true }));

  const missing = item.responses
    .filter((id) => !declared.some((response) => response.id === id))
    .map((id): ItemResponse => ({
      id,
      label: titleCase(id),
      outcome: inferOutcome(id),
      answerable: false,
    }));

  // Appended only when nothing sendable already discards, so a capability that
  // declares its own "Discard" does not render two buttons that do one thing.
  const clearable = known.some((response) => response.outcome === "discard");

  return [...known, ...missing, ...(clearable ? [] : [DISMISS])];
}

/**
 * §4.3 step 2: the headline is "`context.what_happened` or a capability-declared
 * title field". `render.primary` is that field, so it wins when it holds
 * something; `what_happened` is the OS-owned fallback and is never empty.
 *
 * `payload` lets the detail view pass its live draft, so an edited title updates
 * the header as it is typed.
 */
export function itemTitle(
  item: ActionItem,
  resolved: ResolvedType | undefined,
  payload: Record<string, unknown> = item.custom,
): string {
  const primary = resolved?.spec.render.primary;
  const value = primary ? payload[primary] : undefined;
  if (typeof value === "string" && value.trim()) return value;
  return item.context.what_happened;
}
