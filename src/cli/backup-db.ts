#!/usr/bin/env node
/**
 * CLI command: `pnpm backup` (`samaritan backup`).
 * Creates an online SQLite snapshot using `VACUUM INTO` and verifies its
 * restoration integrity via `PRAGMA integrity_check` (PROPOSAL-v1 D6).
 */
import { loadConfig } from "../config/index.js";
import { openDatabase } from "../store/db.js";
import { migrate } from "../store/migrate.js";
import { backupDatabase } from "../store/backup.js";

function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.paths.db);
  try {
    migrate(db);
    const record = backupDatabase(db);
    process.stdout.write(
      `Backup created: ${record.backup_path} (${record.size_bytes} bytes, integrity_ok=${record.integrity_ok})\n`,
    );
    if (!record.integrity_ok) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main();
