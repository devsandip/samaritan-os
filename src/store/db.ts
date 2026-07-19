/**
 * SQLite driver boundary.
 *
 * TECH-SPEC §3 names `better-sqlite3`. That package has no prebuilt binary for
 * Node 26 (ABI node-v147), so we use Node's built-in `node:sqlite` instead — it
 * is synchronous, ships SQLite 3.53 with FTS5, and exposes `loadExtension` for
 * sqlite-vec in v1, which satisfies every property §3's rationale asked for.
 *
 * Every other module in the codebase imports from here and nothing else imports
 * a driver directly, so swapping back to better-sqlite3 is a change to this file
 * alone. See DECISIONS.md.
 */
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type SqlValue = null | number | bigint | string | Uint8Array;

/** A positional parameter, or a single object of named parameters. */
export type SqlParam = SqlValue | Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement<Row = Record<string, SqlValue>> {
  run(...params: SqlParam[]): RunResult;
  get(...params: SqlParam[]): Row | undefined;
  all(...params: SqlParam[]): Row[];
}

export interface Db {
  exec(sql: string): void;
  prepare<Row = Record<string, SqlValue>>(sql: string): Statement<Row>;
  /**
   * Runs `fn` inside a transaction, committing on return and rolling back on
   * throw. Nested calls use SAVEPOINTs, so an inner rollback undoes only the
   * inner work — the caller decides whether to propagate.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
  /** Escape hatch for the rare case a caller needs the raw driver handle. */
  readonly raw: DatabaseSync;
}

class SqliteDb implements Db {
  readonly raw: DatabaseSync;
  #depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    // WAL lets the API server and a shelled-out CLI (TECH-SPEC §12 step 14) read
    // and write the same file concurrently; busy_timeout absorbs the overlap.
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.raw.exec("PRAGMA synchronous = NORMAL");
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare<Row = Record<string, SqlValue>>(sql: string): Statement<Row> {
    const stmt = this.raw.prepare(sql);
    return {
      run: (...params) => stmt.run(...(params as never[])) as RunResult,
      get: (...params) => stmt.get(...(params as never[])) as Row | undefined,
      all: (...params) => stmt.all(...(params as never[])) as Row[],
    };
  }

  transaction<T>(fn: () => T): T {
    const nested = this.#depth > 0;
    const name = `sp_${this.#depth}`;
    // IMMEDIATE takes the write lock up front rather than on first write, so two
    // writers fail fast at BEGIN instead of deadlocking mid-transaction.
    this.raw.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
    this.#depth++;
    try {
      const result = fn();
      this.#depth--;
      this.raw.exec(nested ? `RELEASE ${name}` : "COMMIT");
      return result;
    } catch (err) {
      this.#depth--;
      try {
        this.raw.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
      } catch {
        // A rollback failure means the transaction is already gone (e.g. SQLite
        // rolled it back itself). Surface the original error, not this one.
      }
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export function openDatabase(path: string): Db {
  return new SqliteDb(path);
}
