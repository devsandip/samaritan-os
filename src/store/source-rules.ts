/**
 * Per-source notification and execution rules (PROPOSAL D2).
 *
 * Muting or snoozing a source silences Telegram delivery while the capability
 * continues to run and populate the Inbox. Pausing a source skips scheduled and
 * event-triggered runs completely.
 */
import type { Db } from "./db.js";
import { SourceRule, nowIso } from "../types/index.js";

interface SourceRuleRow {
  source_id: string;
  muted: number;
  snoozed_until: string | null;
  paused: number;
  updated_at: string;
}

function rowToSourceRule(row: SourceRuleRow): SourceRule {
  return SourceRule.parse({
    source_id: row.source_id,
    muted: Boolean(row.muted),
    snoozed_until: row.snoozed_until,
    paused: Boolean(row.paused),
    updated_at: row.updated_at,
  });
}

export function getSourceRule(db: Db, sourceId: string): SourceRule {
  const row = db
    .prepare<SourceRuleRow>("SELECT * FROM source_rules WHERE source_id = ?")
    .get(sourceId);
  if (row) return rowToSourceRule(row);
  return SourceRule.parse({
    source_id: sourceId,
    muted: false,
    snoozed_until: null,
    paused: false,
    updated_at: nowIso(),
  });
}

export function listSourceRules(db: Db): SourceRule[] {
  return db
    .prepare<SourceRuleRow>("SELECT * FROM source_rules ORDER BY source_id ASC")
    .all()
    .map(rowToSourceRule);
}

export function upsertSourceRule(
  db: Db,
  sourceId: string,
  patch: { muted?: boolean; snoozed_until?: string | null; paused?: boolean },
): SourceRule {
  const current = getSourceRule(db, sourceId);
  const next = SourceRule.parse({
    source_id: sourceId,
    muted: patch.muted !== undefined ? patch.muted : current.muted,
    snoozed_until:
      patch.snoozed_until !== undefined ? patch.snoozed_until : current.snoozed_until,
    paused: patch.paused !== undefined ? patch.paused : current.paused,
    updated_at: nowIso(),
  });

  db.prepare(
    `INSERT INTO source_rules (source_id, muted, snoozed_until, paused, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       muted = excluded.muted,
       snoozed_until = excluded.snoozed_until,
       paused = excluded.paused,
       updated_at = excluded.updated_at`,
  ).run(
    next.source_id,
    next.muted ? 1 : 0,
    next.snoozed_until,
    next.paused ? 1 : 0,
    next.updated_at,
  );

  return next;
}

export function isSourceDeliverySilenced(db: Db, sourceId: string, now = new Date()): boolean {
  const rule = getSourceRule(db, sourceId);
  if (rule.muted) return true;
  if (rule.snoozed_until && Date.parse(rule.snoozed_until) > now.getTime()) {
    return true;
  }
  return false;
}

export function isSourcePaused(db: Db, sourceId: string): boolean {
  return getSourceRule(db, sourceId).paused;
}
