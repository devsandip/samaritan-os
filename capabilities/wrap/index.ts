import type {
  DraftActionItem,
  RunContext,
  RunResult,
} from "../../src/run-layer/context.js";

/**
 * Session Wrap (TECH-SPEC §5.2).
 *
 * The extraction is not here and is not meant to be. Deciding what counted as a
 * decision in a working session is language work, and it lives in the Claude
 * skill at plugin/skills/wrap/SKILL.md, which has the conversation in front of
 * it. This entrypoint is the other half: it takes what the skill extracted and
 * puts it through the review gate.
 *
 * Two ways in, same destination:
 *
 *   - The skill pipes JSON to `samaritan emit`, which POSTs to /api/actions.
 *   - Anything holding extracted items calls this, in-process:
 *       pnpm run-capability wrap --input-file items.json
 *
 * Until this existed the manifest declared an entrypoint that was not there, so
 * "Run now" on the Dashboard failed and the capability had no last-run status.
 * A pass-through is a thin thing to be, but declaring a file that does not
 * exist is worse.
 */

/** One extracted row, before it becomes an action item. */
interface WrapItem {
  kind: string;
  title: string;
  detail?: string;
  project?: string;
  owner?: string;
  due?: string;
  evidence?: string;
}

const KINDS = ["decision", "insight", "task", "person", "note"];

function asItem(value: unknown): WrapItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Partial<WrapItem>;
  if (!item.title || !item.kind || !KINDS.includes(item.kind)) return undefined;
  return { ...item, kind: item.kind, title: item.title };
}

/** Stable per (session, item) so a re-wrap of the same session updates, not duplicates. */
function dedupeKey(sessionId: string, item: WrapItem, index: number): string {
  return `wrap:${sessionId}:${item.kind}:${index}`;
}

export async function run(context: RunContext): Promise<RunResult> {
  const payload = context.trigger.payload as { session_id?: string; items?: unknown } | undefined;
  const raw = context.inputs["items"] ?? payload?.items;
  const items = (Array.isArray(raw) ? raw : []).map(asItem).filter(Boolean) as WrapItem[];

  const sessionId =
    (typeof context.inputs["session_id"] === "string" ? context.inputs["session_id"] : undefined) ??
    payload?.session_id ??
    context.trigger.firedAt.slice(0, 19);

  if (!items.length) {
    return {
      action_items: [],
      status: "ok",
      logs: [
        "nothing to file. Extraction happens in the /wrap Claude skill; this " +
          'entrypoint files what it produces. Pass items with --input-file \'{"items":[...]}\'.',
      ],
    };
  }

  const action_items: DraftActionItem[] = items.map((item, index) => ({
    capability_id: "wrap",
    type: "wrap-item-review",
    context: {
      what_happened: `Wrapped a working session and extracted ${items.length} item(s)`,
      source: { kind: "session", id: sessionId },
      provenance: ["wrap.run"],
      // The anchor's whole premise (§12 step 10). Not a confidence judgement:
      // an LLM extraction from a conversation is the highest-inference input in
      // the system and always gets a look.
      why_flagged: "extraction from a conversation always gets a review gate",
      trigger_reason: "action_type",
      confidence: 0.85,
      decision_needed: `File this ${item.kind}?`,
      decision_surface: "inbox",
      execution_surface: item.kind === "task" ? "ticktick" : item.kind === "note" ? "obsidian" : "notion",
      outcome_preview: `Files "${item.title}" as a ${item.kind}`,
    },
    custom: {
      kind: item.kind,
      title: item.title,
      detail: item.detail ?? "",
      project: item.project ?? "",
      owner: item.owner ?? "",
      due: item.due ?? "",
      evidence: item.evidence ?? "",
    },
    dedupe_key: dedupeKey(sessionId, item, index),
  }));

  return { action_items, status: "ok", logs: [`filing ${action_items.length} extracted item(s)`] };
}
