/**
 * Read-only macOS iMessage reader (PROPOSAL-v1 Phase 3, P3-9, C4).
 *
 * Reads unanswered inbound messages from `~/Library/Messages/chat.db` in
 * strict read-only mode (`new DatabaseSync(path, { readOnly: true })`).
 * Every returned message is tagged `scope: "personal"` so it is excluded from
 * default work-scoped MCP queries. Degrades cleanly with an empty list if Full
 * Disk Access is not granted or the database is absent.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expandPath } from "../../config/index.js";

export interface ImessageThreadItem {
  rowid: number;
  sender: string;
  text: string;
  received_at: string;
  scope: "personal";
}

export function readRecentImessages(options: {
  dbPath?: string;
  limit?: number;
} = {}): { accessible: boolean; messages: ImessageThreadItem[]; error?: string } {
  const path = expandPath(options.dbPath ?? "~/Library/Messages/chat.db");
  const limit = options.limit ?? 20;

  if (!existsSync(path)) {
    return {
      accessible: false,
      messages: [],
      error: `chat.db not found at ${path}`,
    };
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT m.ROWID AS rowid,
                COALESCE(h.id, 'unknown') AS sender,
                m.text AS text,
                m.date AS apple_date
         FROM message m
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE m.is_from_me = 0
           AND m.text IS NOT NULL
           AND TRIM(m.text) != ''
         ORDER BY m.ROWID DESC
         LIMIT ?`,
      )
      .all(limit) as {
      rowid: number;
      sender: string;
      text: string;
      apple_date: number;
    }[];

    const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1, 0, 0, 0);
    const messages: ImessageThreadItem[] = rows.map((r) => {
      const offsetMs =
        r.apple_date > 1e12 ? Math.trunc(r.apple_date / 1e6) : r.apple_date * 1000;
      const iso = new Date(APPLE_EPOCH_MS + offsetMs).toISOString();
      return {
        rowid: r.rowid,
        sender: r.sender,
        text: r.text,
        received_at: iso,
        scope: "personal",
      };
    });

    return { accessible: true, messages };
  } catch (err) {
    return {
      accessible: false,
      messages: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors on read-only handle
    }
  }
}
