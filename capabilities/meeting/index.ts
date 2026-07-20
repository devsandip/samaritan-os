import type {
  DraftActionItem,
  RunContext,
  RunResult,
} from "../../src/run-layer/context.js";

/**
 * Meeting Processing (TECH-SPEC §5.2).
 *
 * Same shape as wrap's entrypoint and for the same reason: the extraction is
 * language work and lives in plugin/skills/meeting/SKILL.md, which has the
 * transcript. This files what that produces.
 *
 * Meeting items carry one thing wrap's do not. The Obsidian meeting note is
 * written by the skill directly and is not gated, because it is a reversible
 * local file and writing it is what makes the extraction reviewable in the
 * first place. Its path rides along on every item so the reviewer can open the
 * source of a claim rather than taking the extraction's word for it.
 *
 *   pnpm run-capability meeting --input-file meeting.json
 */

interface MeetingItem {
  kind: string;
  title: string;
  detail?: string;
  project?: string;
  owner?: string;
  due?: string;
  evidence?: string;
}

const KINDS = ["decision", "insight", "task", "person", "note"];

function asItem(value: unknown): MeetingItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Partial<MeetingItem>;
  if (!item.title || !item.kind || !KINDS.includes(item.kind)) return undefined;
  return { ...item, kind: item.kind, title: item.title };
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

export async function run(context: RunContext): Promise<RunResult> {
  const payload = (context.trigger.payload ?? {}) as Record<string, unknown>;
  const from = (key: string): unknown => context.inputs[key] ?? payload[key];

  const raw = from("items");
  const items = (Array.isArray(raw) ? raw : []).map(asItem).filter(Boolean) as MeetingItem[];

  const topic = text(from("meeting_topic"), "Untitled meeting");
  const date = text(from("meeting_date"), context.trigger.firedAt.slice(0, 10));
  const notePath = text(from("meeting_note_path"));

  if (!items.length) {
    return {
      action_items: [],
      status: "ok",
      logs: [
        "nothing to file. Extraction happens in the /meeting Claude skill; this " +
          "entrypoint files what it produces.",
      ],
    };
  }

  const action_items: DraftActionItem[] = items.map((item, index) => ({
    capability_id: "meeting",
    type: "meeting-item-review",
    context: {
      what_happened: `Processed "${topic}" (${date}) and extracted ${items.length} item(s)`,
      source: {
        kind: "meeting",
        id: `${date}:${topic}`,
        ...(notePath ? { link: notePath } : {}),
      },
      provenance: ["meeting.run"],
      // Wrap's risk plus a second-hand source: nobody in the room wrote this
      // down, a transcript did, and then a model read the transcript.
      why_flagged: "extraction from a transcript always gets a review gate",
      trigger_reason: "action_type",
      confidence: 0.8,
      decision_needed: `File this ${item.kind} from ${topic}?`,
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
      meeting_topic: topic,
      meeting_date: date,
      meeting_note_path: notePath,
    },
    dedupe_key: `meeting:${date}:${topic}:${item.kind}:${index}`,
  }));

  return { action_items, status: "ok", logs: [`filing ${action_items.length} extracted item(s)`] };
}
