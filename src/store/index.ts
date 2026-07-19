import { loadConfig } from "../config/index.js";
import { openDatabase, type Db } from "./db.js";
import { migrate } from "./migrate.js";

export type { Db, Statement, SqlValue } from "./db.js";
export { openDatabase } from "./db.js";
export { migrate, currentVersion } from "./migrate.js";
export { MIGRATIONS } from "./migrations.js";

/**
 * Opens the Action Store and brings it up to the current schema version.
 *
 * Migrating on open keeps the CLI (§12 step 14) and the API server from
 * disagreeing about the schema when one of them has been rebuilt and the other
 * has not.
 */
export function openStore(path?: string): Db {
  const dbPath = path ?? loadConfig().paths.db;
  const db = openDatabase(dbPath);
  migrate(db);
  return db;
}
