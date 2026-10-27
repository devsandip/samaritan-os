/**
 * The structured SQL retrieval path (TECH-SPEC §7 step 2, PROPOSAL D3/D4).
 *
 * Queries the local SQLite mirror tables (`notion_decisions`, `notion_insights`,
 * `ticktick_tasks`, `calendar_events`) for entity/keyword matches and returns
 * cited `Passage` records that fuse with semantic (vector + FTS5) passages.
 */
import type { Db } from "../store/db.js";
import type { SourceKind } from "./index-store.js";
import type { Passage } from "./retrieve.js";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "what",
  "when",
  "where",
  "who",
  "why",
  "how",
  "did",
  "does",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "from",
  "that",
  "this",
  "about",
  "into",
]);

export function extractStructuredTokens(question: string): string[] {
  const words = question.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)))].slice(0, 10);
}

function countTokenMatches(haystack: string, tokens: string[]): number {
  const lower = haystack.toLowerCase();
  let matches = 0;
  for (const t of tokens) {
    if (lower.includes(t)) matches += 1;
  }
  return matches;
}

export function structuredRetrieve(
  db: Db,
  question: string,
  opts: { limit?: number } = {},
): Passage[] {
  const limit = opts.limit ?? 5;
  const tokens = extractStructuredTokens(question);
  if (tokens.length === 0) return [];

  const candidates: Passage[] = [];
  let syntheticRowId = -1;

  // 1. notion_decisions
  const decisions = db
    .prepare<{
      id: string;
      title: string | null;
      rationale: string | null;
      project: string | null;
      reversibility: string | null;
    }>("SELECT id, title, rationale, project, reversibility FROM notion_decisions")
    .all();

  for (const row of decisions) {
    const text = `Decision: ${row.title ?? "Untitled"}${row.project ? ` (Project: ${row.project})` : ""}${row.reversibility ? ` [${row.reversibility}]` : ""} - ${row.rationale ?? ""}`.trim();
    const hits = countTokenMatches(text, tokens);
    if (hits > 0) {
      candidates.push({
        rowid: syntheticRowId--,
        kind: "notion_decision" as SourceKind,
        ref: row.id,
        source_path: `notion_decisions/${row.id}`,
        heading: row.title ?? null,
        text,
        score: hits / tokens.length,
        retrievers: ["structured_sql"],
      });
    }
  }

  // 2. notion_insights
  const insights = db
    .prepare<{
      id: string;
      title: string | null;
      body: string | null;
      tags: string | null;
    }>("SELECT id, title, body, tags FROM notion_insights")
    .all();

  for (const row of insights) {
    const text = `Insight: ${row.title ?? "Untitled"}${row.tags ? ` [Tags: ${row.tags}]` : ""} - ${row.body ?? ""}`.trim();
    const hits = countTokenMatches(text, tokens);
    if (hits > 0) {
      candidates.push({
        rowid: syntheticRowId--,
        kind: "notion_insight" as SourceKind,
        ref: row.id,
        source_path: `notion_insights/${row.id}`,
        heading: row.title ?? null,
        text,
        score: hits / tokens.length,
        retrievers: ["structured_sql"],
      });
    }
  }

  // 3. ticktick_tasks
  const tasks = db
    .prepare<{
      id: string;
      title: string | null;
      list: string | null;
      due: string | null;
      status: string | null;
    }>("SELECT id, title, list, due, status FROM ticktick_tasks")
    .all();

  for (const row of tasks) {
    const text = `Task: ${row.title ?? "Untitled"}${row.list ? ` (List: ${row.list})` : ""}${row.due ? ` [Due: ${row.due}]` : ""}${row.status ? ` (${row.status})` : ""}`.trim();
    const hits = countTokenMatches(text, tokens);
    if (hits > 0) {
      candidates.push({
        rowid: syntheticRowId--,
        kind: "ticktick_task" as SourceKind,
        ref: row.id,
        source_path: `ticktick_tasks/${row.id}`,
        heading: row.title ?? null,
        text,
        score: hits / tokens.length,
        retrievers: ["structured_sql"],
      });
    }
  }

  // 4. calendar_events
  const events = db
    .prepare<{
      id: string;
      title: string | null;
      starts_at: string | null;
      ends_at: string | null;
      attendees: string | null;
    }>("SELECT id, title, starts_at, ends_at, attendees FROM calendar_events")
    .all();

  for (const row of events) {
    const text = `Calendar Event: ${row.title ?? "Untitled"} at ${row.starts_at ?? "unknown"}${row.attendees ? ` (Attendees: ${row.attendees})` : ""}`.trim();
    const hits = countTokenMatches(text, tokens);
    if (hits > 0) {
      candidates.push({
        rowid: syntheticRowId--,
        kind: "calendar_event" as SourceKind,
        ref: row.id,
        source_path: `calendar_events/${row.id}`,
        heading: row.title ?? null,
        text,
        score: hits / tokens.length,
        retrievers: ["structured_sql"],
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}
