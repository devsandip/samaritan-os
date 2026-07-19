/**
 * Forward-only migration runner (TECH-SPEC §12 step 3).
 *
 * Each migration runs inside a transaction together with the bookkeeping row
 * that records it, so a migration that fails partway leaves the database exactly
 * as it was rather than half-applied with no way to tell.
 */
import type { Db } from "./db.js";
import { MIGRATIONS, type Migration } from "./migrations.js";
import { log } from "../logger.js";

const logger = log("migrate");

const BOOKKEEPING = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

export interface MigrateResult {
  applied: Migration[];
  version: number;
}

export function currentVersion(db: Db): number {
  db.exec(BOOKKEEPING);
  const row = db
    .prepare<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  return row?.version ?? 0;
}

export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): MigrateResult {
  db.exec(BOOKKEEPING);

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const appliedVersions = new Set(
    db
      .prepare<{ version: number }>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version),
  );

  const applied: Migration[] = [];
  for (const migration of ordered) {
    if (appliedVersions.has(migration.version)) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });

    applied.push(migration);
    logger.info({ version: migration.version, name: migration.name }, "applied migration");
  }

  const version = ordered.at(-1)?.version ?? 0;
  return { applied, version };
}
