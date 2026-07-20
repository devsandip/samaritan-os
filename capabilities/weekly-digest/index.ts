import type {
  DraftActionItem,
  RunContext,
  RunResult,
} from "../../src/run-layer/context.js";

/**
 * Weekly Digest (TECH-SPEC §11(a), §5.2).
 *
 * Reads the week's raw material and writes one note. The synthesis here is
 * grouping and counting, not prose generation: `compose()` is where a model
 * call belongs, and until one is wired the digest says exactly what happened
 * and nothing more.
 *
 * A week with nothing in it produces a digest that says so. That matters more
 * than it sounds: a summarizer that pads an empty week teaches you to stop
 * trusting the full ones.
 */

interface LogEntry {
  at?: string;
  text: string;
  project?: string;
}

interface Row {
  title: string;
  project?: string;
  status?: string;
}

/** ISO week, as `2026-W29`. The digest's identity for the whole week. */
function isoWeek(date: Date): string {
  // Thursday of this week decides the year, per ISO 8601: a week belongs to
  // whichever year holds its Thursday, which is why a naive getFullYear() is
  // wrong for the first days of January.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function asRows(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [{ title: entry }];
    if (typeof entry === "object" && entry !== null) {
      const row = entry as Partial<Row> & { name?: string; decision?: string; insight?: string };
      const title = row.title ?? row.decision ?? row.insight ?? row.name;
      if (typeof title === "string" && title) {
        return [{
          title,
          ...(row.project ? { project: row.project } : {}),
          ...(row.status ? { status: row.status } : {}),
        }];
      }
    }
    return [];
  });
}

function asLog(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [{ text: entry }];
    if (typeof entry === "object" && entry !== null) {
      const log = entry as Partial<LogEntry>;
      if (typeof log.text === "string" && log.text) {
        return [{
          text: log.text,
          ...(log.at ? { at: log.at } : {}),
          ...(log.project ? { project: log.project } : {}),
        }];
      }
    }
    return [];
  });
}

const label = (row: Row): string => (row.project ? `${row.title} (${row.project})` : row.title);

/** Renders the note body. The seam where a model would write prose instead. */
function compose(week: string, sections: Record<string, string[]>, headline: string): string {
  const lines = [`## ${week}`, "", `_${headline}_`, ""];
  for (const [name, entries] of Object.entries(sections)) {
    if (!entries.length) continue;
    lines.push(`### ${name}`, "");
    for (const entry of entries) lines.push(`- ${entry}`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function run(context: RunContext): Promise<RunResult> {
  const week = isoWeek(new Date(context.trigger.firedAt));

  const log = asLog(context.inputs["hourly_log.week"]);
  const decisions = asRows(context.inputs["notion.decisions.week"]);
  const insights = asRows(context.inputs["notion.insights.week"]);

  // "Stuck" is a decision that never resolved. Deriving it rather than asking
  // for it means it cannot silently disagree with the decisions list.
  const stuck = decisions.filter((d) => d.status && d.status !== "resolved");
  const resolved = decisions.filter((d) => !stuck.includes(d));

  const sections = {
    Shipped: log.map((entry) => entry.text),
    Decided: resolved.map(label),
    Learned: insights.map(label),
    Stuck: stuck.map((d) => `${label(d)} — still ${d.status}`),
  };

  const counts = [
    [resolved.length, "decision"],
    [insights.length, "insight"],
    [stuck.length, "stuck item"],
  ] as const;
  const parts = counts
    .filter(([n]) => n > 0)
    .map(([n, noun]) => `${n} ${noun}${n === 1 ? "" : "s"}`);
  const headline = parts.length ? parts.join(", ") : "a quiet week, nothing to report";

  const next = stuck.map((d) => `Unblock: ${label(d)}`);

  const item: DraftActionItem = {
    capability_id: "weekly-digest",
    type: "weekly-digest-ready",
    context: {
      what_happened: `Synthesized ${week}: ${headline}`,
      source: { kind: "schedule", id: week },
      provenance: ["schedule.weekly", "weekly-digest.run", "policy.auto_complete"],
      why_flagged: "not flagged; a digest is derived, reversible and local",
      trigger_reason: "policy",
      confidence: 1,
      decision_needed: "None. This files itself.",
      decision_surface: "inbox",
      execution_surface: "obsidian",
      outcome_preview: `Appends the ${week} digest to Areas/Weekly/${week}.md`,
    },
    custom: {
      headline,
      shipped: sections.Shipped,
      decided: sections.Decided,
      stuck: sections.Stuck,
      next_week: next,
      path: `Areas/Weekly/${week}.md`,
      content: compose(week, sections, headline),
    },
    // The week is the logical event. Re-running mid-week supersedes the pending
    // one; once a week's digest has filed, a re-run is a genuinely new emission.
    dedupe_key: `weekly-digest:${week}`,
  };

  return {
    action_items: [item],
    status: "ok",
    logs: [
      `${week}: ${log.length} log entries, ${decisions.length} decisions, ` +
        `${insights.length} insights, ${stuck.length} stuck`,
    ],
  };
}
