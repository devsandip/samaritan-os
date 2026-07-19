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
import { log } from "../logger.js";
import { RoutingLockedError, UnknownActionTypeError } from "../routing/index.js";
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
  status: ActionItemStatus.optional(),
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

const ConfirmBody = z.object({
  actor: z.enum(["sandip", "system"]).default("sandip"),
  note: z.string().optional(),
});

const ReopenBody = z.object({
  actor: z.enum(["sandip", "system"]).default("sandip"),
  reason: z.string().optional(),
});

const RoutingBody = z.object({
  provider: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  mode: ExecutionMode.optional(),
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

  server.get("/api/capabilities", async () => ({
    capabilities: app.capabilities.all().map((c) => ({
      ...c.manifest,
      types: [...c.types.entries()].map(([type, loaded]) => ({
        type,
        declared_mode: loaded.spec.execution.mode,
        effective_mode: loaded.effectiveMode,
        ...(loaded.degradedReason ? { degraded_reason: loaded.degradedReason } : {}),
      })),
    })),
    problems: app.capabilities.problems(),
  }));

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

export async function start(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = createApp(options);
  const server = buildServer(app);
  const { host, port } = app.config.server;

  await server.listen({ host, port });
  logger.info({ url: `http://${host}:${port}` }, "samaritan api listening");
  return server;
}
