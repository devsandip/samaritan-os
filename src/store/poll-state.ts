/**
 * Durable listener checkpoints (TECH-SPEC §2.2, §12 step 18).
 *
 * The store-backed `PollCheckpoint` the daemon hands the Gmail poller, so a
 * restart resumes from the last message it read instead of refetching the whole
 * backfill window. It is deliberately thin: one row per listener, the cursor an
 * epoch-ms high-water mark. Correctness does not rest on it — the Event Bus
 * dedups on the event id, so a lost or stale cursor costs a refetch, not a
 * double-file — which is why it is a plain upsert with no transaction ceremony.
 */
import type { PollCheckpoint } from "../events/listeners/gmail-poll.js";
import type { Db } from "./db.js";
import { nowIso } from "../types/index.js";

export class StoreCheckpoint implements PollCheckpoint {
  readonly #db: Db;
  readonly #listener: string;

  constructor(db: Db, listener: string) {
    this.#db = db;
    this.#listener = listener;
  }

  /** The saved mark, or 0 before the listener has ever recorded one. */
  load(): number {
    const row = this.#db
      .prepare<{ cursor: string }>("SELECT cursor FROM poll_state WHERE listener = ?")
      .get(this.#listener);
    const value = row ? Number(row.cursor) : 0;
    return Number.isFinite(value) ? value : 0;
  }

  save(epochMs: number): void {
    this.#db
      .prepare(
        `INSERT INTO poll_state (listener, cursor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(listener) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run(this.#listener, String(epochMs), nowIso());
  }
}
