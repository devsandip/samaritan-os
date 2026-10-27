/**
 * Composition root (TECH-SPEC §2.2, "Daemon / kernel").
 *
 * Wires every component together in one place so nothing has to reach for a
 * global. In v0 this is called by the API server and by the CLI; in v1 the
 * daemon calls the same function and adds the scheduler and event listeners
 * around it.
 */
import { dirname, join } from "node:path";
import { loadConfig, repoRoot, type Config } from "./config/index.js";
import { ActionCenter } from "./action-center/index.js";
import { createDelivery, type Delivery } from "./delivery/index.js";
import { EventBus } from "./events/index.js";
import { registerV0Adapters } from "./execution/adapters/index.js";
import { Registry as ExecutionRegistry } from "./execution/registry.js";
import { log } from "./logger.js";
import { CapabilityRegistry } from "./registry/index.js";
import { runCapability } from "./run-layer/index.js";
import { loadRoutingFile, RoutingResolver } from "./routing/index.js";
import type { Embedder } from "./recall/embed.js";
import { RecallService } from "./recall/service.js";
import type { Synthesizer } from "./recall/synthesize.js";
import { openDatabase, type Db } from "./store/db.js";
import { migrate } from "./store/migrate.js";
import { nowIso } from "./types/index.js";
import { createTaskAnswerAdapter } from "./execution/adapters/task-answer.js";
import { WorkerService, type WorkerExecutor } from "./worker/index.js";

const logger = log("app");

export interface App {
  config: Config;
  db: Db;
  execution: ExecutionRegistry;
  capabilities: CapabilityRegistry;
  routing: RoutingResolver;
  delivery: Delivery;
  actionCenter: ActionCenter;
  eventBus: EventBus;
  recall: RecallService;
  worker: WorkerService;
  close(): void;
}

export interface CreateAppOptions {
  dbPath?: string;
  capabilitiesDir?: string;
  routingPath?: string;
  artifactsRoot?: string;
  workerExecutor?: WorkerExecutor;
  /**
   * Test seam: inject a deterministic embedder/synthesiser so Recall queries run
   * without the model download or a network call. Production leaves this unset
   * and the service resolves both from config.
   */
  recall?: { embedder?: Embedder; synthesizer?: Synthesizer };
}

export function createApp(options: CreateAppOptions = {}): App {
  const config = loadConfig();
  const db = openDatabase(options.dbPath ?? config.paths.db);
  migrate(db);

  // Execution first: the capability registry cross-checks against it to decide
  // which action-item types degrade to guided (§10).
  const execution = new ExecutionRegistry(db);
  registerV0Adapters(execution, db);
  // Answering a worker's question resumes the task. The worker is built below,
  // after the Action Center it depends on, so the adapter resolves it late.
  let worker: WorkerService | undefined;
  execution.register(createTaskAnswerAdapter(() => worker));

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

  // Telegram buttons offer the item's first committing response (or, for a
  // card that commits nothing, such as the meeting-notes nudge, its first
  // answer) and its snooze. A worker's question gets neither: it is answered by
  // replying to it.
  const delivery = createDelivery(db, (item) => {
    const responses = capabilities.getType(item.capability_id, item.type)?.spec.responses ?? [];
    const approve =
      item.type === "task-question"
        ? undefined
        : (responses.find((r) => r.outcome === "execute" || r.outcome === "guided") ??
          responses.find((r) => r.outcome === "discard"));
    const snooze = responses.find((r) => r.outcome === "defer");
    return {
      ...(approve ? { approve: { id: approve.id, label: approve.label } } : {}),
      ...(snooze ? { snooze: { id: snooze.id, label: snooze.label } } : {}),
    };
  });
  const actionCenter = new ActionCenter({
    db,
    capabilities,
    execution,
    routing,
    delivery,
    quietHours: config.delivery.quiet_hours,
    policyConfig: {
      valueThreshold: config.policy.value_threshold,
      escalateIrreversible: config.policy.escalate_irreversible,
    },
  });

  // Recall answers questions over the vault, journals and audit trail. The
  // embedder and synthesiser resolve from config, but both are injectable so a
  // test drives real queries without a model download or a network call.
  const recall = new RecallService({
    db,
    config,
    ...(options.recall?.embedder ? { embedder: options.recall.embedder } : {}),
    ...(options.recall?.synthesizer ? { synthesizer: options.recall.synthesizer } : {}),
  });

  // The Event Bus fires event-mode capabilities through the same Run Layer a
  // scheduled or manual run uses, so an event fire is one more path into one
  // dispatcher, not a parallel one. It lives on the App (not just the daemon)
  // because a webhook route calls straight into publish() at request time.
  const eventBus = new EventBus({
    db,
    capabilities,
    fire: async (capabilityId, event) => {
      await runCapability(
        { db, capabilities, actionCenter },
        capabilityId,
        {
          admissionKey: `event:${capabilityId}:${event.id}`,
          trigger: { mode: "event", firedAt: event.occurred_at ?? nowIso(), payload: event.payload },
          recall: async (question: string) => {
            return recall.query(question);
          },
        },
      );
    },
  });

  const defaultArtifactsRoot =
    options.artifactsRoot ??
    (options.dbPath && options.dbPath !== ":memory:"
      ? join(dirname(options.dbPath), "artifacts")
      : undefined);

  worker = new WorkerService({
    db,
    actionCenter,
    recall,
    config: config.worker,
    ...(defaultArtifactsRoot ? { artifactsRoot: defaultArtifactsRoot } : {}),
    ...(options.workerExecutor ? { executor: options.workerExecutor } : {}),
  });

  return {
    config,
    db,
    execution,
    capabilities,
    routing,
    delivery,
    actionCenter,
    eventBus,
    recall,
    worker,
    close: () => {
      worker?.stop();
      db.close();
    },
  };
}
