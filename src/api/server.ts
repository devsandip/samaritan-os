/**
 * Web UI / API server (TECH-SPEC §5.1, §2.2).
 *
 * A Fastify instance serving `/api/*` and, once built, the SPA from the same
 * origin. Bound to 127.0.0.1 only (§9): the trust boundary is "who can reach
 * loopback on this machine", so there is no auth in v0. That stays true only
 * while no tunnel is in front of it; §9 requires a bearer check before one is.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { ActionCenterError } from "../action-center/index.js";
import { createApp, type App, type CreateAppOptions } from "../app.js";
import { repoRoot } from "../config/index.js";
import { GmailPoller } from "../events/listeners/gmail-poll.js";
import { createGmailSource } from "../events/listeners/gmail-source.js";
import { VaultWatcher } from "../events/listeners/vault-watch.js";
import { SamaritanEvent } from "../events/types.js";
import { StoreCheckpoint } from "../store/poll-state.js";
import { registerWebhooks } from "./webhooks.js";
import { log } from "../logger.js";
import { RoutingLockedError, UnknownActionTypeError } from "../routing/index.js";
import { runCapability } from "../run-layer/index.js";
import { Scheduler } from "../scheduler/index.js";
import { MoneyLockViolation } from "../guardrails.js";
import {
  getActionItem,
  listActionItems,
  listAuditTrail,
  IllegalTransitionError,
} from "../store/action-items.js";
import { ActionItemStatus, ExecutionMode, Priority } from "../types/index.js";

const logger = log("api");

const IngestBody = z.object({
  capability_id: z.string().min(1),
  items: z.array(z.unknown()).min(1),
});

const ListQuery = z.object({
  /**
   * Repeat the param to ask for several: `?status=pending&status=in_review`.
   * Fastify hands back a bare string for one and an array for many, so both
   * shapes are accepted; `listActionItems` takes either.
   *
   * Views that span statuses (the Inbox covers four) used to fan out one request
   * per status and merge client-side, which applied `limit` per status rather
   * than to the result and returned them grouped by status rather than in the
   * server's priority order.
   */
  status: z.union([ActionItemStatus, z.array(ActionItemStatus).min(1)]).optional(),
  capability_id: z.string().optional(),
  priority: Priority.optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const RespondBody = z.object({
  response_id: z.string().min(1),
  edited_payload: z.record(z.string(), z.unknown()).optional(),
  actor: z.enum(["sandip", "system", "policy", "capability"]).default("sandip"),
});

const BatchBody = z.object({
  ids: z.array(z.string().min(1)).min(1),
  response_id: z.string().min(1),
  actor: z.enum(["sandip", "system", "policy", "capability"]).default("sandip"),
});

const ConfirmBody = z.object({
  actor: z.enum(["sandip", "system"]).default("sandip"),
  note: z.string().optional(),
});

const ReopenBody = z.object({
  actor: z.enum(["sandip", "system"]).default("sandip"),
  reason: z.string().optional(),
});

const RunBody = z.object({
  /** Resolved from `manifest.context.inputs`; unsupplied keys are reported, not fatal. */
  inputs: z.record(z.string(), z.unknown()).optional(),
  /** Run even when the manifest says `enabled: false`. */
  force: z.boolean().default(false),
});

const RoutingBody = z.object({
  provider: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  mode: ExecutionMode.optional(),
});

const RecallQueryBody = z.object({
  question: z.string().min(1).max(2000),
  max_citations: z.coerce.number().int().min(1).max(40).optional(),
});

function badRequest(error: z.ZodError) {
  return {
    error: {
      code: "invalid_request",
      message: error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    },
  };
}

export function buildServer(app: App): FastifyInstance {
  const server = Fastify({ logger: false });

  server.setErrorHandler((err, _request, reply) => {
    if (err instanceof ActionCenterError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof RoutingLockedError || err instanceof MoneyLockViolation) {
      return reply.code(409).send({ error: { code: "locked", message: err.message } });
    }
    if (err instanceof UnknownActionTypeError) {
      return reply.code(404).send({ error: { code: "not_found", message: err.message } });
    }
    if (err instanceof IllegalTransitionError) {
      return reply.code(409).send({ error: { code: "illegal_transition", message: err.message } });
    }
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error({ err: error.message, stack: error.stack }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal", message: error.message } });
  });

  server.get("/healthz", async () => ({
    status: "ok",
    capabilities: app.capabilities.all().length,
    problems: app.capabilities.problems().length,
  }));

  // ---- Action Center -------------------------------------------------------

  server.post("/api/actions", async (request, reply) => {
    const body = IngestBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send(badRequest(body.error));

    const result = await app.actionCenter.ingest(body.data.capability_id, body.data.items);
    // 202: the items are durably persisted before this returns (§10), but the
    // work they represent has not necessarily happened yet.
    return reply.code(202).send(result);
  });

  server.get("/api/actions", async (request, reply) => {
    const query = ListQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send(badRequest(query.error));

    const { status, capability_id, priority, type, limit, offset } = query.data;
    return {
      items: listActionItems(app.db, {
        ...(status ? { status } : {}),
        ...(capability_id ? { capability_id } : {}),
        ...(priority ? { priority } : {}),
        ...(type ? { type } : {}),
        limit,
        offset,
      }),
    };
  });

  server.get<{ Params: { id: string } }>("/api/actions/:id", async (request, reply) => {
    const item = getActionItem(app.db, request.params.id);
    if (!item) {
      return reply.code(404).send({ error: { code: "not_found", message: "action item not found" } });
    }
    return item;
  });

  server.get<{ Params: { id: string } }>("/api/actions/:id/audit", async (request, reply) => {
    if (!getActionItem(app.db, request.params.id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "action item not found" } });
    }
    return { events: listAuditTrail(app.db, request.params.id) };
  });

  server.post<{ Params: { id: string } }>("/api/actions/:id/respond", async (request, reply) => {
    const body = RespondBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    return app.actionCenter.respond(request.params.id, body.data);
  });

  // Batch-approve for similar low-risk items (§12 step 23). A committing response
  // is applied only to items the risk gate clears; the rest come back as
  // `skipped`. Per-item outcomes, so a partial batch still returns 200 with the
  // failures itemised rather than failing the whole request.
  server.post("/api/actions/batch", async (request, reply) => {
    const body = BatchBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    return app.actionCenter.batchRespond(body.data);
  });

  server.post<{ Params: { id: string } }>("/api/actions/:id/confirm", async (request, reply) => {
    const body = ConfirmBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    return app.actionCenter.confirm(request.params.id, body.data);
  });

  server.post<{ Params: { id: string } }>("/api/actions/:id/reopen", async (request, reply) => {
    const body = ReopenBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    return app.actionCenter.reopen(request.params.id, body.data);
  });

  // ---- Capabilities --------------------------------------------------------

  server.get("/api/capabilities", async () => {
    // Run telemetry lives on the `capabilities` row, written by the Run Layer.
    // Before it existed the Dashboard's agent grid approximated "last run" from
    // item timestamps and said so in a comment; this is the real thing.
    const runs = new Map(
      app.db
        .prepare<{ id: string; last_run_at: string | null; last_run_status: string | null }>(
          "SELECT id, last_run_at, last_run_status FROM capabilities",
        )
        .all()
        .map((row) => [row.id, row]),
    );

    // When the Scheduler fires is persisted on the trigger row, not held in the
    // Scheduler object, so the Dashboard reads exactly what will fire — and
    // reads it whether or not a daemon is currently up to run the Scheduler.
    const nextFire = new Map(
      app.db
        .prepare<{ capability_id: string; next_fire_at: string | null }>(
          "SELECT capability_id, next_fire_at FROM triggers",
        )
        .all()
        .map((row) => [row.capability_id, row.next_fire_at]),
    );

    return {
      capabilities: app.capabilities.all().map((c) => ({
        ...c.manifest,
        last_run_at: runs.get(c.manifest.id)?.last_run_at ?? null,
        last_run_status: runs.get(c.manifest.id)?.last_run_status ?? null,
        next_fire_at: nextFire.get(c.manifest.id) ?? null,
        types: [...c.types.entries()].map(([type, loaded]) => ({
          type,
          declared_mode: loaded.spec.execution.mode,
          effective_mode: loaded.effectiveMode,
          ...(loaded.degradedReason ? { degraded_reason: loaded.degradedReason } : {}),
        })),
      })),
      problems: app.capabilities.problems(),
    };
  });

  server.get<{ Params: { id: string } }>("/api/capabilities/:id", async (request, reply) => {
    const capability = app.capabilities.get(request.params.id);
    if (!capability) {
      return reply.code(404).send({ error: { code: "not_found", message: "capability not found" } });
    }
    return capability.manifest;
  });

  server.post("/api/capabilities/reload", async () => {
    const { loaded, problems } = app.capabilities.reload();
    return { reloaded: loaded.map((c) => c.manifest.id), problems };
  });

  /**
   * Fires a capability now. Backs the Dashboard's "Run now" and gives a Claude
   * scheduled task a way to trigger a run against the live daemon rather than
   * opening the Action Store a second time.
   *
   * A failed run is still a 200: the report *is* the answer, and §10's contract
   * is that one capability failing is a normal condition the OS absorbs, not an
   * API error. The one 4xx is a capability that does not exist, which is a
   * caller mistake rather than a run outcome.
   */
  server.post<{ Params: { id: string } }>("/api/capabilities/:id/run", async (request, reply) => {
    const body = RunBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(badRequest(body.error));

    if (!app.capabilities.get(request.params.id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "capability not found" } });
    }
    return runCapability(app, request.params.id, {
      ...(body.data.inputs ? { inputs: body.data.inputs } : {}),
      force: body.data.force,
    });
  });

  // ---- Events --------------------------------------------------------------

  /**
   * Publishes one event onto the bus. This is what a listener posts to — a real
   * `POST /webhooks/gmail` would normalise its body and call the same path — and
   * what the demo and `samaritan emit-event` use to inject an event by hand.
   *
   * Always 202: a dropped duplicate (`deduped: true`) is a normal, successful
   * outcome of publishing, not a client error, so the body reports what happened
   * rather than the status code.
   */
  server.post("/api/events", async (request, reply) => {
    const event = SamaritanEvent.safeParse(request.body);
    if (!event.success) return reply.code(400).send(badRequest(event.error));
    return reply.code(202).send(await app.eventBus.publish(event.data));
  });

  // Inbound webhooks (Fireflies today) live in their own encapsulated plugin so
  // their raw-body parser — needed to verify a signature over the exact bytes —
  // stays scoped to them and does not change how the rest of the API parses JSON.
  registerWebhooks(server, app);

  // ---- Recall --------------------------------------------------------------

  /**
   * Ask-Samaritan (§5.5, §7). Retrieves cited passages from the vault, journals
   * and audit trail and — when synthesis is enabled — writes an answer over them.
   * A miss is a 200 with no citations and a plain "couldn't find it", not a 404:
   * the question was well-formed, the index just held no answer for it.
   */
  server.post("/api/recall/query", async (request, reply) => {
    const body = RecallQueryBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    return app.recall.query(
      body.data.question,
      body.data.max_citations ? { maxCitations: body.data.max_citations } : {},
    );
  });

  server.get("/api/recall/stats", async () => app.recall.stats());

  // ---- Routing -------------------------------------------------------------

  server.get("/api/routing", async () => ({ routing: app.routing.list() }));

  server.put<{ Params: { action_type: string } }>(
    "/api/routing/:action_type",
    async (request, reply) => {
      const body = RoutingBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send(badRequest(body.error));
      return app.routing.update(request.params.action_type, body.data);
    },
  );

  // ---- SPA -----------------------------------------------------------------

  const spa = join(repoRoot(), "ui", "dist");
  if (existsSync(spa)) {
    void server.register(fastifyStatic, { root: spa });
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: { code: "not_found", message: "no such endpoint" } });
      }
      return reply.sendFile("index.html");
    });
  }

  return server;
}

/** How often the ttl and resurface sweeps run while the server is up. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Runs the time-based sweeps. The API server process is the long-lived one, so
 * it is the only thing that can notice that a ttl or a defer window has elapsed
 * — the same reason it now also hosts the Scheduler (§12 step 17): one process,
 * one event loop, the daemon skeleton §6 describes. Both sweeps were previously
 * written and never called, which is why a deferred item never came back.
 *
 * Order matters: an item past both its ttl and its snooze should expire rather
 * than briefly reappear in the Inbox.
 */
async function sweep(app: App): Promise<void> {
  try {
    const expired = app.actionCenter.expire();
    const resurfaced = await app.actionCenter.resurface();
    if (expired || resurfaced) logger.info({ expired, resurfaced }, "swept");
  } catch (err) {
    // A failed sweep must not take down the server; the next tick retries.
    logger.error({ err: String(err) }, "sweep failed");
  }
}

/** How often the daemon refreshes the Recall index while it is up (§7). */
const RECALL_REINDEX_INTERVAL_MS = 15 * 60_000;

/**
 * Refreshes the Recall index in the background (§7). Idempotent by content hash,
 * so a tick that finds nothing changed is a walk and a few hashes. Guarded like
 * the sweep: an indexing failure logs and waits for the next tick rather than
 * taking the daemon down. Runs after listen() — the local model downloads on
 * first use, and that must never delay the socket.
 */
async function backgroundReindex(app: App): Promise<void> {
  try {
    const tally = await app.recall.reindex();
    if (tally.indexed || tally.removed) logger.info(tally, "recall reindexed");
  } catch (err) {
    logger.error({ err: String(err) }, "recall reindex failed");
  }
}

export async function start(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = createApp(options);
  const server = buildServer(app);
  const { host, port } = app.config.server;

  // The Scheduler fires scheduled-mode capabilities on their cron by running
  // them through the same Run Layer a manual "Run now" uses, so a cron fire and
  // a hand fire are the same code path and the same audit trail (§12 step 17).
  const scheduler = new Scheduler({
    db: app.db,
    fire: async (ctx) => {
      await runCapability(app, ctx.capabilityId, {
        trigger: { mode: "scheduled", firedAt: ctx.scheduledFor },
      });
    },
  });

  // The vault watch is the Event Bus's first real listener: a note written to
  // the vault publishes onto the same bus a webhook or the `emit-event` CLI does
  // (§12 step 18). It runs here for the same reason the Scheduler does — this is
  // the one long-lived process, so it is the one that can hold a file watch open.
  const watcher = new VaultWatcher({
    roots: [{ dir: app.config.paths.vault, kind: "note", source: "vault" }],
    publish: (event) => app.eventBus.publish(event),
  });

  // The Gmail poller is the bus's first *networked* listener (§12 step 18). It
  // publishes onto the same bus the watch and emit-event do, so email-triage and
  // newsletter-digest cannot tell a real inbox from a hand-emitted event. It is
  // idle unless config turns it on *and* a token is in the Keychain — createGmail
  // Source returns undefined otherwise — so the daemon starts either way. Its
  // checkpoint is store-backed, so a restart resumes rather than refetching.
  const gmail = app.config.gmail;
  const gmailPoller = new GmailPoller({
    source: gmail.enabled
      ? createGmailSource({
          account: gmail.account,
          query: gmail.query,
          backfillDays: gmail.backfill_days,
          maxPerPoll: gmail.max_per_poll,
        })
      : undefined,
    publish: (event) => app.eventBus.publish(event),
    checkpoint: new StoreCheckpoint(app.db, "gmail"),
    intervalMs: gmail.poll_interval_ms,
  });

  // Both before listen(): Fastify refuses addHook once the instance is
  // listening, and unref() keeps the timers from holding the process open.
  const timer = setInterval(() => void sweep(app), SWEEP_INTERVAL_MS);
  timer.unref();
  const reindexTimer = setInterval(() => void backgroundReindex(app), RECALL_REINDEX_INTERVAL_MS);
  reindexTimer.unref();
  server.addHook("onClose", async () => {
    clearInterval(timer);
    clearInterval(reindexTimer);
    scheduler.stop();
    await watcher.stop();
    gmailPoller.stop();
  });

  // Boot reconciliation (§11) runs before the socket opens, deliberately. It
  // re-drives items a crash stranded in `approved` mid-execution, and that
  // recovery is only sound while nothing else dispatches: once listen() accepts
  // a request, a respond() could be inside execute() with its own `approved`
  // item and `pending` execution row, and reconcile() would mistake that live
  // work for a crash remnant. Before listen — scheduler and watcher still
  // stopped — every such row is a genuine remnant, which is what it assumes.
  await app.actionCenter.reconcile();

  await server.listen({ host, port });

  // Once on boot, so anything that came due while the process was down is
  // handled immediately rather than up to a minute later.
  await sweep(app);
  // The Scheduler's own catch-up (§11 case 3) then ticks on its interval. After
  // listen, so the server is answering before any catch-up run starts.
  await scheduler.start();
  // After the scheduler, so a note written during boot catch-up still fires.
  await watcher.start();
  // The Gmail poller last: its first poll runs at start(), so the socket and the
  // in-process listeners are already up when the first mail arrives on the bus.
  await gmailPoller.start();

  // Recall refreshes its index once now, in the background: the first run
  // downloads the local model and embeds the vault, which must not block the
  // socket. The interval timer above keeps it current from here.
  void backgroundReindex(app);

  logger.info({ url: `http://${host}:${port}` }, "samaritan api listening");
  return server;
}
