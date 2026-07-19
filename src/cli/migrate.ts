#!/usr/bin/env node
/** `pnpm migrate` - applies pending migrations to the Action Store. */
import { loadConfig } from "../config/index.js";
import { openDatabase } from "../store/db.js";
import { currentVersion, migrate } from "../store/migrate.js";

const config = loadConfig();
const db = openDatabase(config.paths.db);

const before = currentVersion(db);
const { applied, version } = migrate(db);
db.close();

if (applied.length === 0) {
  console.log(`Action Store at ${config.paths.db} is already at version ${before}.`);
} else {
  console.log(
    `Action Store at ${config.paths.db}: applied ${applied.length} migration(s), ` +
      `${before} -> ${version}\n` +
      applied.map((m) => `  ${m.version}  ${m.name}`).join("\n"),
  );
}
