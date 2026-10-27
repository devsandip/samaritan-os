import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../../src/config/index.js";
import { fetchFirefliesTranscript } from "../../src/events/listeners/fireflies-client.js";
import { resolveInVault } from "../../src/execution/adapters/obsidian.js";
import { sanitizeTickTickText } from "../../src/execution/adapters/ticktick.js";
import type {
  DraftActionItem,
  RunContext,
  RunResult,
} from "../../src/run-layer/context.js";

/**
 * Meeting Processing (TECH-SPEC §5.2, PROPOSAL Phase 1).
 *
 * Accepts either structured `items[]` (from the `/meeting` skill) or raw
 * `notes` / `transcript` text (from `POST /api/meetings/notes`, Granola, or
 * the `meeting.transcribed` Fireflies event).
 *
 * When raw notes are supplied and the Obsidian vault is present, writes the
 * reversible meeting note directly to `Areas/Meetings/<date> - <topic>.md` and
 * emits every extracted decision, task, or insight as a reviewable Inbox item.
 * Empty meetings produce zero Inbox items.
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

/**
 * Extracts structured items from pasted meeting notes or transcript lines.
 * Recognises lines prefixed with `Decision:`, `Decided:`, `Task:`, `Todo:`,
 * `Action:`, `- [ ]`, `Insight:`, or `Note:`.
 */
export function extractItemsFromNotes(rawNotes: string, defaultProject = ""): MeetingItem[] {
  const results: MeetingItem[] = [];
  const lines = rawNotes.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.replace(/^[\s*-]+/, "").trim();
    if (!line) continue;

    const decisionMatch = /^(?:decision|decided)\s*:\s*(.+)$/i.exec(line);
    if (decisionMatch?.[1]) {
      results.push({
        kind: "decision",
        title: decisionMatch[1].trim(),
        detail: rawLine.trim(),
        project: defaultProject,
      });
      continue;
    }

    const taskMatch = /^(?:task(?:\s+for\s+([a-z0-9_.-]+))?|todo|action|\[\s*\])\s*:?\s*(.+)$/i.exec(
      line,
    );
    if (taskMatch?.[2]) {
      results.push({
        kind: "task",
        title: sanitizeTickTickText(taskMatch[2].trim()),
        owner: taskMatch[1]?.trim() ?? "sandip",
        detail: rawLine.trim(),
        project: defaultProject,
      });
      continue;
    }

    const insightMatch = /^(?:insight|learning)\s*:\s*(.+)$/i.exec(line);
    if (insightMatch?.[1]) {
      results.push({
        kind: "insight",
        title: insightMatch[1].trim(),
        detail: rawLine.trim(),
        project: defaultProject,
      });
      continue;
    }
  }

  return results;
}

function safeSlug(topic: string): string {
  return (
    topic
      .replace(/[/\\?%*:|"<>]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Untitled meeting"
  );
}

export async function run(context: RunContext): Promise<RunResult> {
  const payload = (context.trigger.payload ?? {}) as Record<string, unknown>;
  const from = (key: string): unknown => context.inputs[key] ?? payload[key];

  let topic = text(from("meeting_topic") ?? from("title"), "Untitled meeting");
  let date = text(from("meeting_date"), context.trigger.firedAt.slice(0, 10));
  const defaultProject = text(from("project"));
  let rawNotes = text(from("notes") ?? from("transcript") ?? from("fireflies.transcript"));

  const meetingId = text(from("meeting_id") ?? from("id"));
  if (!rawNotes.trim() && meetingId) {
    try {
      const fetched = await fetchFirefliesTranscript(meetingId);
      if (fetched) {
        if (topic === "Untitled meeting" && fetched.title) topic = fetched.title;
        if (fetched.dateIso) date = fetched.dateIso;
        rawNotes = fetched.transcriptText;
      }
    } catch {
      // Leave rawNotes empty if Fireflies GraphQL is unreachable.
    }
  }

  let notePath = text(from("meeting_note_path"));
  if (!notePath && rawNotes.trim()) {
    const relPath = join("Areas", "Meetings", `${date} - ${safeSlug(topic)}.md`);
    try {
      const vaultRoot = loadConfig().paths.vault;
      const absTarget = resolveInVault(vaultRoot, relPath);
      mkdirSync(dirname(absTarget), { recursive: true });
      writeFileSync(
        absTarget,
        `# ${topic} (${date})\n\n${rawNotes.trim()}\n`,
        "utf8",
      );
      notePath = relPath;
    } catch {
      notePath = relPath;
    }
  }

  const raw = from("items");
  let items = (Array.isArray(raw) ? raw : []).map(asItem).filter(Boolean) as MeetingItem[];
  if (!items.length && rawNotes.trim()) {
    items = extractItemsFromNotes(rawNotes, defaultProject);
  }

  if (!items.length) {
    return {
      action_items: [],
      status: "ok",
      logs: [
        "nothing to file. Extraction happens in the /meeting Claude skill or from structured notes; this " +
          "entrypoint files what it produces.",
      ],
    };
  }

  const action_items: DraftActionItem[] = items.map((item, index) => {
    const cleanTitle =
      item.kind === "task" ? sanitizeTickTickText(item.title) : item.title;
    return {
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
        execution_surface:
          item.kind === "task" ? "ticktick" : item.kind === "note" ? "obsidian" : "notion",
        outcome_preview: `Files "${cleanTitle}" as a ${item.kind}`,
      },
      custom: {
        kind: item.kind,
        title: cleanTitle,
        detail: item.detail ?? "",
        project: item.project ?? defaultProject,
        owner: item.owner ?? "",
        due: item.due ?? "",
        evidence: item.evidence ?? "",
        meeting_topic: topic,
        meeting_date: date,
        meeting_note_path: notePath,
      },
      dedupe_key: `meeting:${date}:${topic}:${item.kind}:${index}`,
    };
  });

  return {
    action_items,
    status: "ok",
    logs: [`filing ${action_items.length} extracted item(s)`],
  };
}
