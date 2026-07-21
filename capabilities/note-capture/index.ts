import { basename } from "node:path";
import type { DraftActionItem, RunContext, RunResult } from "../../src/run-layer/context.js";

/**
 * Note Capture (TECH-SPEC §2.2, §4.2).
 *
 * The first capability to fire on a filesystem event rather than a clock or a
 * message. The chokidar vault watch publishes `note.created` when a file lands
 * in the vault; the Event Bus routes the ones in `Inbox/` here (the manifest's
 * filter), and this turns each into one reviewable item.
 *
 * It reads only the event — the note's path, title and folder — and never opens
 * the file. That keeps `run()` a pure function of its trigger, testable without
 * a disk, and honest about what it knows: a capture card carries the note's name
 * and where it landed, and the source link points at the note itself for the
 * rest. The judgement of what the note *is* is Sandip's, which is why every
 * capture escalates.
 */

interface Capture {
  /** Vault-relative path, e.g. "Inbox/call-dentist.md". */
  path: string;
  /** Note title — the filename without its extension. */
  title: string;
  /** Parent folder relative to the vault root, e.g. "Inbox". */
  folder: string;
  /** When the capture fired, ISO 8601. */
  capturedAt: string;
}

/** Reads the `note.created` payload defensively; returns undefined if it carries no path. */
function asCapture(payload: unknown, firedAt: string): Capture | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  const path = typeof p["path"] === "string" ? p["path"] : "";
  if (!path) return undefined;

  const declaredTitle = typeof p["title"] === "string" ? p["title"].trim() : "";
  const title = declaredTitle || basename(path).replace(/\.md$/i, "");
  const folder = typeof p["folder"] === "string" ? p["folder"] : "";
  return { path, title, folder, capturedAt: firedAt };
}

/**
 * Builds the one reviewable item a capture becomes. Pure and exported, so it is
 * tested directly the way the vault watch's mapper is — no Run Layer, no disk.
 */
export function buildCaptureItem(capture: Capture): DraftActionItem {
  const where = capture.folder || "the vault";
  return {
    capability_id: "note-capture",
    type: "note-capture-review",
    context: {
      what_happened: `You captured "${capture.title}" in ${where}`,
      source: { kind: "note", id: capture.path, link: capture.path },
      provenance: ["note.created", "note-capture.run"],
      why_flagged: "a new note landed in your Inbox and has not been processed",
      trigger_reason: "value",
      // The capture is certain; what to do with it is the open question, which is
      // why the manifest escalates rather than this number deciding.
      confidence: 1,
      decision_needed: "Turn this captured note into a task?",
      decision_surface: "inbox",
      execution_surface: "ticktick",
      outcome_preview: `Stages a TickTick task: "${capture.title}"`,
    },
    custom: {
      // Fixed to task: pm-os.item.file dispatches on this, so a captured note
      // approved becomes a TickTick task (staged, guided).
      kind: "task",
      title: capture.title,
      detail: `Captured from ${capture.path}`,
      project: "",
      owner: "",
      due: "",
      evidence: `note:${capture.path}`,
      folder: capture.folder,
      captured_at: capture.capturedAt,
    },
    // Keyed on the path, not the event id: recreating the same note is the same
    // capture, and the event id (path@mtime) already fired only once on the bus.
    dedupe_key: `note-capture:${capture.path}`,
  };
}

export async function run(context: RunContext): Promise<RunResult> {
  const capture = asCapture(context.trigger.payload, context.trigger.firedAt);
  if (!capture) {
    return {
      action_items: [],
      status: "ok",
      logs: [
        "no note path in the trigger payload; note-capture fires on a note.created " +
          "event from the vault watch (§12 step 18) and had nothing to capture.",
      ],
    };
  }

  return {
    action_items: [buildCaptureItem(capture)],
    status: "ok",
    logs: [`captured "${capture.title}" from ${capture.path}`],
  };
}
