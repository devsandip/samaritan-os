/**
 * Composition root (TECH-SPEC §2.2, "Daemon / kernel").
 *
 * Wires every component together in one place so nothing has to reach for a
 * global. In v0 this is called by the API server and by the CLI; in v1 the
 * daemon calls the same function and adds the scheduler and event listeners
 * around it.
 */
import { join } from "node:path";
import { loadConfig, repoRoot, type Config } from "./config/index.js";
import { ActionCenter } from "./action-center/index.js";
import { registerV0Adapters } from "./execution/adapters/index.js";
import { Registry as ExecutionRegistry } from "./execution/registry.js";
import { log } from "./logger.js";
import { CapabilityRegistry } from "./registry/index.js";
import { loadRoutingFile, RoutingResolver } from "./routing/index.js";
import { openDatabase, type Db } from "./store/db.js";
import { migrate } from "./store/migrate.js";

const logger = log("app");

export interface App {
  config: Config;
  db: Db;
  execution: ExecutionRegistry;
  capabilities: CapabilityRegistry;
  routing: RoutingResolver;
  actionCenter: ActionCenter;
  close(): void;
}

export interface CreateAppOptions {
  dbPath?: string;
  capabilitiesDir?: string;
  routingPath?: string;
}

export function createApp(options: CreateAppOptions = {}): App {
  const config = loadConfig();
  const db = openDatabase(options.dbPath ?? config.paths.db);
  migrate(db);

  // Execution first: the capability registry cross-checks against it to decide
  // which action-item types degrade to guided (§10).
  const execution = new ExecutionRegistry(db);
  registerV0Adapters(execution, db);

  const routing = new RoutingResolver(db);
  const routingPath = options.routingPath ?? join(repoRoot(), "routing.yaml");
  routing.setOverrides(loadRoutingFile(db, routingPath));

  const capabilities = new CapabilityRegistry({
    db,
    capabilitiesDir:
      options.capabilitiesDir ?? config.paths.capabilities ?? join(repoRoot(), "capabilities"),
    executionCatalogue: execution,
  });
  const { loaded, problems } = capabilities.reload();
  logger.info({ capabilities: loaded.length, problems: problems.length }, "registry loaded");

  const actionCenter = new ActionCenter({ db, capabilities, execution, routing });

  return {
    config,
    db,
    execution,
    capabilities,
    routing,
    actionCenter,
    close: () => db.close(),
  };
}
