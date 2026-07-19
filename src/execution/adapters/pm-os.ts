/**
 * PM-OS filing adapter (TECH-SPEC §12 step 10).
 *
 * The anchor emits a single action-item type per capability
 * (`wrap-item-review` / `meeting-item-review`), but the items inside it are of
 * several kinds: a decision goes to the Notion Decisions database, an insight to
 * Insights, a task to TickTick, a person to People. A manifest declares one
 * execution target per type, so this adapter is that target and dispatches on
 * `custom.kind` to the underlying adapter.
 *
 * It deliberately holds no filing logic of its own. Every branch delegates to an
 * adapter that is separately registered and separately testable, so this stays a
 * routing table rather than becoming a second implementation.
 */
import type {
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "../../types/index.js";

export const PM_OS_KINDS = ["decision", "insight", "task", "person", "note"] as const;
export type PmOsKind = (typeof PM_OS_KINDS)[number];

/** Which adapter files each kind. */
const TARGETS: Record<PmOsKind, string> = {
  decision: "notion.decision.create",
  insight: "notion.insight.create",
  // People rows are insight-shaped enough for v0 and no People adapter exists
  // yet; filing them as insights keeps them findable rather than dropping them.
  person: "notion.insight.create",
  task: "ticktick.task.create",
  note: "obsidian.note.append",
};

/** The generic item shape every anchor capability declares. */
interface PmOsItem {
  title: string;
  detail: string;
  project: string;
  owner: string;
  due: string;
  evidence: string;
}

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function dailyNoteRelativePath(): string {
  return `Areas/Daily/${new Date().toISOString().slice(0, 10)}.md`;
}

/**
 * Translates the generic PM-OS item into the payload its target adapter expects.
 *
 * This translation is the whole reason this adapter exists. Forwarding the item
 * unchanged only works when the two shapes happen to agree, and they do not:
 * Notion wants `rationale`, TickTick wants `due`, Obsidian wants a `path` and
 * `content` that are not on the item at all. Keeping the mapping here means a
 * capability's manifest declares one uniform, reviewable shape and never has to
 * carry per-destination fields.
 */
export function payloadFor(kind: PmOsKind, item: Record<string, unknown>): Record<string, unknown> {
  const p: PmOsItem = {
    title: text(item, "title"),
    detail: text(item, "detail"),
    project: text(item, "project"),
    owner: text(item, "owner"),
    due: text(item, "due"),
    evidence: text(item, "evidence"),
  };

  switch (kind) {
    case "decision":
      return {
        title: p.title,
        ...(p.detail ? { rationale: p.detail } : {}),
        ...(p.evidence ? { evidence: p.evidence } : {}),
        ...(p.project ? { project: p.project } : {}),
      };
    case "insight":
      return {
        title: p.title,
        ...(p.detail ? { body: p.detail } : {}),
        ...(p.project ? { project: p.project } : {}),
        tags: p.project ? [] : ["unsorted"],
      };
    case "person":
      return {
        title: p.title,
        ...(p.detail ? { body: p.detail } : {}),
        ...(p.project ? { project: p.project } : {}),
        tags: ["person"],
      };
    case "task":
      return {
        title: p.title,
        ...(p.due ? { due: p.due } : {}),
        ...(p.project ? { list: p.project } : {}),
      };
    case "note":
      return {
        path: dailyNoteRelativePath(),
        content: [`## ${p.title}`, p.detail].filter(Boolean).join("\n\n"),
      };
  }
}

export interface AdapterLookup {
  get(id: string): ExecutionAdapter | undefined;
}

export function pmOsItemFile(lookup: AdapterLookup): ExecutionAdapter {
  return {
    id: "pm-os.item.file",
    provider: "samaritan",
    description: "Files a reviewed PM-OS item to whichever system its kind belongs in",
    // Never automated on its own account: the mode it runs in is the mode the
    // item was approved under, and the underlying adapter has the final say.
    modes: ["automated", "assisted", "guided"],

    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      const kind = request.payload["kind"];
      if (typeof kind !== "string" || !(PM_OS_KINDS as readonly string[]).includes(kind)) {
        return {
          status: "failed",
          error: `payload.kind must be one of ${PM_OS_KINDS.join(", ")}, got ${JSON.stringify(kind)}`,
        };
      }

      const targetId = TARGETS[kind as PmOsKind];
      const target = lookup.get(targetId);
      if (!target) {
        return { status: "failed", error: `no adapter registered for "${targetId}"` };
      }

      // Run in the strongest mode the target actually supports, capped by the
      // mode this request was approved under. A target that only does guided
      // (TickTick in v0) stages instead of committing, which lands the item in
      // awaiting_confirmation per §5.3 rather than claiming a write it did not do.
      const mode = target.modes.includes(request.mode)
        ? request.mode
        : target.modes.includes("guided")
          ? "guided"
          : target.modes[0]!;

      return target.execute({
        ...request,
        capability: targetId,
        mode,
        payload: payloadFor(kind as PmOsKind, request.payload),
      });
    },

    async verify() {
      // Health is the union of its targets, which the registry reports
      // individually. Nothing to check here.
      return "connected";
    },
  };
}
