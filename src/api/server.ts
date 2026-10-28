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
import { loadConfig, repoRoot } from "../config/index.js";
import { acquireInstanceLock } from "../store/instance-lock.js";
import { getSecret } from "../secrets.js";
import {
  handleTelegramUpdate,
  TelegramPoller,
  type TelegramUpdate,
} from "../delivery/telegram-inbound.js";
import {
  CalendarPoller,
  createGoogleCalendarSource,
} from "../events/listeners/calendar-sync.js";
import {
  handleCodingAgentHook,
  type CodingAgentHookPayload,
} from "../events/listeners/coding-agent-hook.js";
import { GmailPoller } from "../events/listeners/gmail-poll.js";
import { createGmailSource } from "../events/listeners/gmail-source.js";
import { VaultWatcher, discoverJournalRoots } from "../events/listeners/vault-watch.js";
import { SamaritanEvent } from "../events/types.js";
import { StoreCheckpoint } from "../store/poll-state.js";
import { registerWebhooks } from "./webhooks.js";
import { log } from "../logger.js";
import { handleMcpRequest, type JsonRpcRequest } from "../mcp/index.js";
import { RoutingLockedError, UnknownActionTypeError } from "../routing/index.js";
import { cancelRun, runCapability } from "../run-layer/index.js";
import { checkBillingAllowance } from "../run-layer/billing.js";
import {
  backupDatabase,
  listBackups,
  probeKeychainAccess,
} from "../store/backup.js";
import { currentVersion } from "../store/migrate.js";
import { Scheduler } from "../scheduler/index.js";
import { MoneyLockViolation } from "../guardrails.js";
import { authGate, callerOf, checkLogin, configuredToken, sessionCookieHeader } from "./auth.js";
import {
  getActionItem,
  getActionItemByDedupeKey,
  listActionItems,
  listAuditTrail,
  IllegalTransitionError,
  transition,
} from "../store/action-items.js";
import { getRun, listRuns } from "../store/runs.js";
import {
  getSourceRule,
  listSourceRules,
  upsertSourceRule,
} from "../store/source-rules.js";
import {
  listActivityEvents,
  listArtifacts,
  listTasks,
} from "../store/tasks.js";
import {
  ActionItemStatus,
  ActivityEventType,
  ExecutionMode,
  Priority,
  RunRecordStatus,
  TaskLane,
  TaskStatus,
} from "../types/index.js";

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
  expected_payload_hash: z.string().min(1).optional(),
  expected_revision: z.coerce.number().int().min(1).optional(),
  actor: z.enum(["sandip", "system", "policy", "capability"]).optional(),
});

const BatchBody = z.object({
  ids: z.array(z.string().min(1)).min(1),
  response_id: z.string().min(1),
  /** The revision on screen for each id. A committing batch needs one per item (D9). */
  revisions: z.record(z.string(), z.coerce.number().int().min(1)).optional(),
  actor: z.enum(["sandip", "system", "policy", "capability"]).optional(),
});

const ConfirmBody = z.object({
  actor: z.enum(["sandip", "system"]).optional(),
  note: z.string().optional(),
  expected_payload_hash: z.string().min(1).optional(),
  expected_revision: z.coerce.number().int().min(1).optional(),
});

const ReopenBody = z.object({
  actor: z.enum(["sandip", "system"]).optional(),
  reason: z.string().optional(),
});

const RunBody = z.object({
  /** Resolved from `manifest.context.inputs`; unsupplied keys are reported, not fatal. */
  inputs: z.record(z.string(), z.unknown()).optional(),
  /** Run even when the manifest says `enabled: false`. */
  force: z.boolean().default(false),
  admission_key: z.string().min(1).optional(),
});

const TaskSubmitBody = z.object({
  goal: z.string().min(1),
  lane: TaskLane.default("general"),
  parent_task_id: z.string().nullable().optional(),
  /** Client idempotency key: resubmitting returns the original task. */
  request_key: z.string().min(1).max(200).optional(),
});

const TaskListQuery = z.object({
  status: z.union([TaskStatus, z.array(TaskStatus).min(1)]).optional(),
  lane: TaskLane.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const TaskAnswerBody = z
  .object({
    answer: z.string().min(1),
    /** The question on screen. A later question will not take an answer meant for this one. */
    question_id: z.string().min(1).optional(),
    expected_revision: z.coerce.number().int().min(1).optional(),
  })
  .refine((b) => b.question_id !== undefined || b.expected_revision !== undefined, {
    message: "name the question (question_id) or the task revision (expected_revision) you are answering",
  });

const CancelBody = z.object({
  reason: z.string().optional(),
});

const RunsQuery = z.object({
  task_id: z.string().optional(),
  capability_id: z.string().optional(),
  status: z.union([RunRecordStatus, z.array(RunRecordStatus).min(1)]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const ActivityQuery = z.object({
  after_cursor: z.coerce.number().int().min(0).optional(),
  task_id: z.string().optional(),
  run_id: z.string().optional(),
  capability_id: z.string().optional(),
  type: ActivityEventType.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const SourceRuleBody = z.object({
  muted: z.boolean().optional(),
  snoozed_until: z.string().nullable().optional(),
  paused: z.boolean().optional(),
});

const MeetingNotesBody = z.object({
  /** The calendar event these notes are for, when known (from the nudge link). */
  event_id: z.string().min(1).optional(),
  meeting_topic: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  meeting_date: z.string().optional(),
  date: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  notes: z.string().min(1),
  project: z.string().optional(),
});

const RoutingBody = z.object({
  provider: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  mode: ExecutionMode.optional(),
});

const RecallQueryBody = z.object({
  question: z.string().min(1).max(2000),
  max_citations: z.coerce.number().int().min(1).max(40).optional(),
  scope: z.enum(["work", "personal", "all"]).optional(),
});

/** The local calendar day of an ISO timestamp (or a plain YYYY-MM-DD). */
function localDay(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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

  // Who is calling is decided here, never by the request body (D5, D9).
  server.addHook("onRequest", authGate);

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

  // ---- System Health, Backup & Remote MCP OAuth (P0-3, P0-4, P4-4) ----------

  server.get("/api/system/health", async () => {
    let integrity = "unknown";
    try {
      const row = app.db.prepare<{ integrity_check: string }>("PRAGMA integrity_check").get();
      integrity = row?.integrity_check ?? "unknown";
    } catch (err) {
      integrity = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const backups = listBackups(app.db, 10);
    const keychain = probeKeychainAccess();
    const billing = checkBillingAllowance(app.db, app.config.billing.monthly_cap_usd);
    const syncCursors = app.db
      .prepare<{
        source: string;
        cursor: string | null;
        last_success_at: string | null;
        last_error: string | null;
      }>("SELECT * FROM sync_cursors ORDER BY source ASC")
      .all();

    return {
      status: integrity === "ok" ? "ok" : "degraded",
      schema_version: currentVersion(app.db),
      sqlite_integrity: integrity,
      keychain,
      billing,
      backups,
      sync_cursors: syncCursors,
      capabilities: app.capabilities.all().length,
      problems: app.capabilities.problems().length,
    };
  });

  server.get("/api/connections", async () => {
    const cursors = new Map(
      app.db
        .prepare<{
          source: string;
          cursor: string | null;
          last_success_at: string | null;
          last_error: string | null;
        }>("SELECT * FROM sync_cursors")
        .all()
        .map((c) => [c.source, c]),
    );

    const checkSecretStatus = (
      enabled: boolean,
      keychainAccount: string,
      cursorSource?: string,
    ): {
      status: "connected" | "not_configured" | "error";
      last_sync_at: string | null;
      last_error: string | null;
    } => {
      const cur = cursorSource ? cursors.get(cursorSource) : undefined;
      if (cur?.last_error) {
        return {
          status: "error",
          last_sync_at: cur.last_success_at,
          last_error: cur.last_error,
        };
      }
      const hasSecret = Boolean(getSecret(keychainAccount));
      return {
        status: enabled && hasSecret ? "connected" : "not_configured",
        last_sync_at: cur?.last_success_at ?? null,
        last_error: null,
      };
    };

    const cfg = app.config;
    const vaultPresent = existsSync(cfg.paths.vault);
    const connections = [
      {
        id: "obsidian",
        name: "Obsidian Vault",
        provider: "obsidian",
        enabled: true,
        keychain_account: cfg.paths.vault,
        status: vaultPresent ? ("connected" as const) : ("not_configured" as const),
        last_sync_at: null,
        last_error: vaultPresent ? null : "Vault directory not found on disk",
      },
      {
        id: "notion",
        name: "Notion PM-OS",
        provider: "notion",
        enabled: true,
        keychain_account: `notion:${cfg.notion.account}`,
        ...checkSecretStatus(true, `notion:${cfg.notion.account}`, "notion.decisions"),
      },
      {
        id: "google.calendar",
        name: "Google Calendar",
        provider: "google-calendar",
        enabled: cfg.calendar.enabled,
        keychain_account: `gcal:${cfg.calendar.account}`,
        ...checkSecretStatus(
          cfg.calendar.enabled,
          `gcal:${cfg.calendar.account}`,
          "google.calendar",
        ),
      },
      {
        id: "gmail",
        name: "Gmail (Read + Draft)",
        provider: "gmail",
        enabled: cfg.gmail.enabled,
        keychain_account: `gmail:${cfg.gmail.account}`,
        ...checkSecretStatus(cfg.gmail.enabled, `gmail:${cfg.gmail.account}`, "gmail"),
      },
      {
        id: "ticktick",
        name: "TickTick Open API",
        provider: "ticktick",
        enabled: cfg.ticktick.enabled,
        keychain_account: `ticktick:${cfg.ticktick.account}`,
        ...checkSecretStatus(cfg.ticktick.enabled, `ticktick:${cfg.ticktick.account}`, "ticktick"),
      },
      {
        id: "fireflies",
        name: "Fireflies Transcripts",
        provider: "fireflies",
        enabled: cfg.fireflies.enabled,
        keychain_account: `fireflies:${cfg.fireflies.account}`,
        ...checkSecretStatus(cfg.fireflies.enabled, `fireflies:${cfg.fireflies.account}`),
      },
      {
        id: "slack",
        name: "Slack Events Webhook",
        provider: "slack",
        enabled: cfg.slack.enabled,
        keychain_account: `slack:${cfg.slack.account}`,
        ...checkSecretStatus(cfg.slack.enabled, `slack:${cfg.slack.account}`),
      },
      {
        id: "telegram",
        name: "Telegram Bot",
        provider: "telegram",
        enabled: cfg.delivery.telegram.enabled,
        keychain_account: "telegram:bot",
        ...checkSecretStatus(cfg.delivery.telegram.enabled, "telegram:bot"),
      },
      {
        id: "hevy",
        name: "Hevy Workouts API",
        provider: "hevy",
        enabled: true,
        keychain_account: "hevy:default",
        ...checkSecretStatus(true, "hevy:default"),
      },
      {
        id: "oura",
        name: "Oura Ring V2",
        provider: "oura",
        enabled: true,
        keychain_account: "oura:default",
        ...checkSecretStatus(true, "oura:default"),
      },
      {
        id: "posthog",
        name: "PostHog Analytics",
        provider: "posthog",
        enabled: cfg.posthog.enabled,
        keychain_account: `posthog:${cfg.posthog.account}`,
        ...checkSecretStatus(cfg.posthog.enabled, `posthog:${cfg.posthog.account}`),
      },
      {
        id: "nutgraf",
        name: "Nutgraf Reader",
        provider: "nutgraf",
        enabled: cfg.nutgraf.enabled,
        keychain_account: `nutgraf:${cfg.nutgraf.account}`,
        ...checkSecretStatus(cfg.nutgraf.enabled, `nutgraf:${cfg.nutgraf.account}`),
      },
      {
        id: "thornhill",
        name: "Thornhill Phone Agent",
        provider: "thornhill",
        enabled: cfg.thornhill.enabled,
        keychain_account: `thornhill:${cfg.thornhill.account}`,
        ...checkSecretStatus(cfg.thornhill.enabled, `thornhill:${cfg.thornhill.account}`),
      },
      {
        id: "anthropic.worker",
        name: "Anthropic Worker API",
        provider: "anthropic",
        enabled: cfg.worker.monthly_budget_usd > 0,
        keychain_account: `anthropic:${cfg.worker.account}`,
        ...checkSecretStatus(
          cfg.worker.monthly_budget_usd > 0,
          `anthropic:${cfg.worker.account}`,
        ),
      },
    ];

    return { connections };
  });

  server.post("/api/system/backup", async () => {
    const backup = backupDatabase(app.db);
    return { backup };
  });

  server.get("/.well-known/oauth-authorization-server", async (request) => {
    const proto = (request.headers["x-forwarded-proto"] as string | undefined) ?? "http";
    const host = request.headers.host ?? `${app.config.server.host}:${app.config.server.port}`;
    const baseUrl = `${proto}://${host}`;
    return {
      issuer: baseUrl,
      token_endpoint: `${baseUrl}/api/oauth/token`,
      grant_types_supported: ["client_credentials"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      scopes_supported: ["mcp:work", "mcp:personal", "mcp:full"],
    };
  });

  server.post("/api/oauth/token", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const authHeader = request.headers.authorization;
    const bearer =
      authHeader && authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim()
        : undefined;
    const secret =
      typeof body.client_secret === "string"
        ? body.client_secret
        : bearer;
    const expectedMcp = getSecret("mcp:token");
    const expectedWeb = getSecret("web:token");
    const valid =
      (expectedMcp && secret === expectedMcp) ||
      (expectedWeb && secret === expectedWeb) ||
      (!expectedMcp && !expectedWeb && typeof secret === "string" && secret.length > 0);
    if (!valid || !secret) {
      return reply.code(401).send({
        error: "invalid_client",
        error_description: "client_secret did not match configured mcp:token or web:token",
      });
    }
    const requestedScope = typeof body.scope === "string" ? body.scope : "mcp:work";
    return {
      access_token: secret,
      token_type: "Bearer",
      expires_in: 86400,
      scope: requestedScope,
    };
  });

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
    // Server-derived actor: human review routes always attribute decisions to
    // "sandip", never trusting a client-supplied actor override (PROPOSAL G2).
    return app.actionCenter.respond(request.params.id, {
      response_id: body.data.response_id,
      require_binding: true,
      ...(body.data.edited_payload ? { edited_payload: body.data.edited_payload } : {}),
      ...(body.data.expected_payload_hash
        ? { expected_payload_hash: body.data.expected_payload_hash }
        : {}),
      ...(body.data.expected_revision !== undefined
        ? { expected_revision: body.data.expected_revision }
        : {}),
      actor: "sandip",
    });
  });

  // Batch-approve for similar low-risk items (§12 step 23). A committing response
  // is applied only to items the risk gate clears; the rest come back as
  // `skipped`. Per-item outcomes, so a partial batch still returns 200 with the
  // failures itemised rather than failing the whole request.
  server.post("/api/actions/batch", async (request, reply) => {
    const body = BatchBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    return app.actionCenter.batchRespond({
      ids: body.data.ids,
      response_id: body.data.response_id,
      ...(body.data.revisions ? { revisions: body.data.revisions } : {}),
      require_binding: true,
      actor: "sandip",
    });
  });

  server.post<{ Params: { id: string } }>("/api/actions/:id/confirm", async (request, reply) => {
    const body = ConfirmBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    return app.actionCenter.confirm(request.params.id, {
      actor: "sandip",
      ...(body.data.note ? { note: body.data.note } : {}),
      ...(body.data.expected_payload_hash
        ? { expected_payload_hash: body.data.expected_payload_hash }
        : {}),
      ...(body.data.expected_revision !== undefined
        ? { expected_revision: body.data.expected_revision }
        : {}),
    });
  });

  server.post<{ Params: { id: string } }>("/api/actions/:id/reopen", async (request, reply) => {
    const body = ReopenBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    return app.actionCenter.reopen(request.params.id, {
      actor: "sandip",
      ...(body.data.reason ? { reason: body.data.reason } : {}),
    });
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
      ...(body.data.admission_key ? { admissionKey: body.data.admission_key } : {}),
      recall: (q) => app.recall.query(q),
      force: body.data.force,
    });
  });

  // ---- Auth (Tailscale / phone web session) --------------------------------

  server.post("/api/auth/login", async (request, reply) => {
    const body = z.object({ token: z.string().min(1) }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    if (!configuredToken()) {
      return reply.code(409).send({
        error: {
          code: "no_token",
          message:
            "no web:token is set. Add one with: security add-generic-password -s samaritan -a web:token -w",
        },
      });
    }
    const session = checkLogin(body.data.token);
    if (!session) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "that token is wrong" } });
    }
    reply.header("Set-Cookie", sessionCookieHeader(request, session));
    return { authenticated: true };
  });

  server.post("/api/auth/logout", async (request, reply) => {
    reply.header("Set-Cookie", sessionCookieHeader(request, "", 0));
    return { authenticated: false };
  });

  /** What the UI needs to decide whether to show the sign-in screen. */
  server.get("/api/auth/session", async (request) => {
    const caller = callerOf(request);
    return {
      authenticated: caller.kind === "human",
      token_configured: Boolean(configuredToken()),
      via: caller.kind === "human" ? caller.via : null,
    };
  });

  // ---- Now Snapshot --------------------------------------------------------

  /** D2's Now view: today, what needs Sandip, what is running, how fresh each source is. */
  server.get("/api/now", async () => {
    const now = new Date();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const inbox = listActionItems(app.db, {
      status: ["pending", "in_review", "awaiting_confirmation"],
      limit: 50,
    });
    const inboxCount =
      app.db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM action_items WHERE status IN ('pending','in_review','awaiting_confirmation')",
        )
        .get()?.n ?? 0;
    const meetings = app.db
      .prepare<{
        id: string;
        title: string;
        starts_at: string;
        ends_at: string | null;
        attendees: string | null;
        last_synced_at: string | null;
      }>(
        `SELECT * FROM calendar_events
          WHERE COALESCE(ends_at, starts_at) >= ? AND starts_at < ?
          ORDER BY starts_at ASC LIMIT 20`,
      )
      .all(now.toISOString(), endOfDay)
      .map((m) => ({
        ...m,
        attendees: m.attendees ? (JSON.parse(m.attendees) as string[]) : [],
      }));
    return {
      inbox,
      inbox_count: inboxCount,
      tasks: listTasks(app.db, {
        status: ["queued", "running", "needs_input", "awaiting_review", "interrupted"],
        limit: 25,
      }),
      running: listRuns(app.db, { status: "running", limit: 25 }),
      meetings,
      source_rules: listSourceRules(app.db),
      sync_cursors: app.db
        .prepare<{
          source: string;
          cursor: string | null;
          last_success_at: string | null;
          last_error: string | null;
        }>("SELECT * FROM sync_cursors ORDER BY source ASC")
        .all(),
      worker: {
        month_spend_usd: app.worker.monthSpendUsd(),
        monthly_budget_usd: app.config.worker.monthly_budget_usd,
      },
    };
  });

  // ---- Delegated Tasks, Runs, Artifacts & Activity -------------------------

  server.get("/api/tasks", async (request, reply) => {
    const query = TaskListQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send(badRequest(query.error));
    return {
      tasks: app.worker.listTasks({
        ...(query.data.status ? { status: query.data.status } : {}),
        ...(query.data.lane ? { lane: query.data.lane } : {}),
        limit: query.data.limit,
        offset: query.data.offset,
      }),
    };
  });

  server.post("/api/tasks", async (request, reply) => {
    const body = TaskSubmitBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    // Durably queued before the 202; the run happens in the background (D1).
    const submitted = app.worker.submit({
      goal: body.data.goal,
      lane: body.data.lane,
      origin: "ui",
      ...(body.data.parent_task_id !== undefined
        ? { parent_task_id: body.data.parent_task_id }
        : {}),
      ...(body.data.request_key ? { request_key: body.data.request_key } : {}),
    });
    return reply.code(submitted.created ? 202 : 200).send(submitted);
  });

  server.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = app.worker.getTask(request.params.id);
    if (!task) {
      return reply.code(404).send({ error: { code: "not_found", message: "task not found" } });
    }
    const runs = listRuns(app.db, { task_id: task.id, limit: 20 });
    const artifacts = listArtifacts(app.db, { task_id: task.id, limit: 50 });
    const events = listActivityEvents(app.db, { task_id: task.id, limit: 100 });
    const actionItems = listActionItems(app.db, { task_id: task.id, limit: 50 });
    const openQuestion = actionItems.find(
      (i) => i.type === "task-question" && ["pending", "in_review", "deferred"].includes(i.status),
    );
    return {
      task,
      runs,
      artifacts,
      events,
      action_items: actionItems,
      open_question: openQuestion ?? null,
    };
  });

  server.post<{ Params: { id: string } }>("/api/tasks/:id/answer", async (request, reply) => {
    const body = TaskAnswerBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    if (body.data.question_id) {
      const question = getActionItem(app.db, body.data.question_id);
      if (question?.task_id !== request.params.id) {
        return reply.code(404).send({ error: { code: "not_found", message: "no such question on this task" } });
      }
    }
    const updated = await app.worker.answer(body.data.question_id ?? request.params.id, body.data.answer, {
      actor: "sandip",
      ...(body.data.expected_revision !== undefined
        ? { expectedRevision: body.data.expected_revision }
        : {}),
    });
    return { task: updated };
  });

  server.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request, reply) => {
    const body = CancelBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    const task = await app.worker.cancel(request.params.id, body.data.reason);
    if (!task) {
      return reply.code(404).send({ error: { code: "not_found", message: "task not found" } });
    }
    return { task };
  });

  server.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (request) => ({
    task: app.worker.start(request.params.id),
  }));

  server.get("/api/runs", async (request, reply) => {
    const query = RunsQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send(badRequest(query.error));
    return {
      runs: listRuns(app.db, {
        ...(query.data.task_id ? { task_id: query.data.task_id } : {}),
        ...(query.data.capability_id ? { capability_id: query.data.capability_id } : {}),
        ...(query.data.status ? { status: query.data.status } : {}),
        limit: query.data.limit,
      }),
    };
  });

  server.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request, reply) => {
    const body = CancelBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    if (!getRun(app.db, request.params.id)) {
      return reply.code(404).send({ error: { code: "not_found", message: "run not found" } });
    }
    const before = getRun(app.db, request.params.id);
    const cancelled = cancelRun(app.db, request.params.id, body.data.reason);
    // A run that had already ended is reported as such, not as "stopped".
    return { run: cancelled, stopped: before?.status === "running" };
  });

  server.get<{ Params: { id: string } }>("/api/artifacts/:id", async (request, reply) => {
    const found = app.worker.getArtifact(request.params.id);
    if (!found) {
      return reply.code(404).send({ error: { code: "not_found", message: "artifact not found" } });
    }
    return found;
  });

  server.get("/api/activity", async (request, reply) => {
    const query = ActivityQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send(badRequest(query.error));
    const events = listActivityEvents(app.db, {
      ...(query.data.after_cursor !== undefined ? { after_cursor: query.data.after_cursor } : {}),
      ...(query.data.task_id ? { task_id: query.data.task_id } : {}),
      ...(query.data.run_id ? { run_id: query.data.run_id } : {}),
      ...(query.data.capability_id ? { capability_id: query.data.capability_id } : {}),
      ...(query.data.type ? { type: query.data.type } : {}),
      limit: query.data.limit,
    });
    const runs = listRuns(app.db, { limit: 30 });
    const seenEvents = app.db
      .prepare<{ id: string; event_type: string; seen_at: string }>(
        "SELECT id, event_type, seen_at FROM seen_events ORDER BY seen_at DESC LIMIT 30",
      )
      .all();
    return { events, runs, seen_events: seenEvents };
  });

  // ---- Source Rules (Mute / Snooze / Pause per capability) -----------------

  server.get("/api/source-rules", async () => {
    const syncCursors = app.db
      .prepare<{
        source: string;
        cursor: string | null;
        last_success_at: string | null;
        last_error: string | null;
      }>("SELECT * FROM sync_cursors ORDER BY source ASC")
      .all();
    return {
      rules: listSourceRules(app.db),
      sync_cursors: syncCursors,
    };
  });

  server.get<{ Params: { source_id: string } }>(
    "/api/source-rules/:source_id",
    async (request) => getSourceRule(app.db, request.params.source_id),
  );

  server.put<{ Params: { source_id: string } }>(
    "/api/source-rules/:source_id",
    async (request, reply) => {
      const body = SourceRuleBody.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send(badRequest(body.error));
      return upsertSourceRule(app.db, request.params.source_id, {
        ...(body.data.muted !== undefined ? { muted: body.data.muted } : {}),
        ...(body.data.snoozed_until !== undefined
          ? { snoozed_until: body.data.snoozed_until }
          : {}),
        ...(body.data.paused !== undefined ? { paused: body.data.paused } : {}),
      });
    },
  );

  // ---- Meetings Notes Intake & Coding-Agent Hooks --------------------------

  server.post("/api/meetings/notes", async (request, reply) => {
    const body = MeetingNotesBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    const meeting = body.data.event_id
      ? app.db
          .prepare<{ title: string; starts_at: string; attendees: string | null }>(
            "SELECT title, starts_at, attendees FROM calendar_events WHERE id = ?",
          )
          .get(body.data.event_id)
      : undefined;
    const topic = body.data.meeting_topic ?? body.data.title ?? meeting?.title ?? "Meeting Notes";
    const date = body.data.meeting_date ?? body.data.date ?? meeting?.starts_at;
    const attendees =
      body.data.attendees ?? (meeting?.attendees ? (JSON.parse(meeting.attendees) as string[]) : undefined);
    const report = await runCapability(app, "meeting", {
      inputs: {
        meeting_topic: topic,
        ...(date ? { meeting_date: localDay(date) } : {}),
        ...(attendees ? { attendees } : {}),
        ...(body.data.event_id ? { event_id: body.data.event_id } : {}),
        notes: body.data.notes,
        ...(body.data.project ? { project: body.data.project } : {}),
      },
      force: true,
    });
    // The notes arrived, so the nudge for this meeting has done its job.
    if (body.data.event_id && report.status === "ok") {
      const nudge = getActionItemByDedupeKey(app.db, "meeting-followup", `meeting-followup:${body.data.event_id}`);
      if (nudge && ["pending", "in_review", "deferred"].includes(nudge.status)) {
        await app.actionCenter.respond(nudge.id, { response_id: "notes_added", actor: "sandip" });
      }
    }
    // Like a capability run: a failed run is a normal reply with the reason in the body.
    return reply.code(202).send(report);
  });

  server.post("/api/meetings/granola", async (request, reply) => {
    const raw = (request.body ?? {}) as Record<string, unknown>;
    const topic =
      (typeof raw.title === "string" && raw.title) ||
      (typeof raw.meeting_topic === "string" && raw.meeting_topic) ||
      "Granola Meeting Notes";
    const notes =
      (typeof raw.markdown === "string" && raw.markdown) ||
      (typeof raw.notes === "string" && raw.notes) ||
      (typeof raw.transcript === "string" && raw.transcript) ||
      "";
    if (!notes.trim()) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "markdown, notes, or transcript is required" },
      });
    }
    const date =
      (typeof raw.date === "string" && raw.date) ||
      (typeof raw.meeting_date === "string" && raw.meeting_date) ||
      undefined;
    const attendees = Array.isArray(raw.attendees)
      ? raw.attendees.filter((a): a is string => typeof a === "string")
      : undefined;
    const report = await runCapability(app, "meeting", {
      inputs: {
        meeting_topic: topic,
        ...(date ? { meeting_date: date } : {}),
        ...(attendees ? { attendees } : {}),
        notes,
      },
      force: true,
    });
    return reply.code(202).send(report);
  });

  server.post("/api/hooks/coding-agent", async (request, reply) => {
    const payload = (request.body ?? {}) as CodingAgentHookPayload;
    const outcome = await handleCodingAgentHook(app, payload);
    return reply.code(202).send(outcome);
  });

  // ---- MCP JSON-RPC over HTTP & Telegram Inbound ---------------------------

  // Streamable HTTP transport, JSON responses only (D4). The stdio entrypoint
  // proxies here, so every assistant talks to the one running daemon.
  server.post("/api/mcp", async (request, reply) => {
    const body = request.body;
    if (Array.isArray(body)) {
      const replies = (
        await Promise.all(body.map((m) => handleMcpRequest(app, m as JsonRpcRequest)))
      ).filter((r) => r !== undefined);
      return replies.length ? replies : reply.code(202).send();
    }
    const response = await handleMcpRequest(app, (body ?? {}) as JsonRpcRequest);
    return response ?? reply.code(202).send();
  });

  server.post("/api/telegram/webhook", async (request, reply) => {
    const update = (request.body ?? {}) as TelegramUpdate;
    const outcome = await handleTelegramUpdate(
      {
        db: app.db,
        actionCenter: app.actionCenter,
        worker: app.worker,
        eventBus: app.eventBus,
        onMeetingNotes: async ({ topic, notes }) => {
          await runCapability(app, "meeting", {
            inputs: { meeting_topic: topic, notes },
            force: true,
          });
        },
      },
      update,
    );
    return reply.code(outcome.accepted ? 200 : 403).send(outcome);
  });
  server.get("/api/mcp", async (_request, reply) =>
    reply.code(405).header("allow", "POST").send({ error: { code: "method_not_allowed", message: "POST JSON-RPC to /api/mcp" } }),
  );

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
    return app.recall.query(body.data.question, {
      ...(body.data.max_citations ? { maxCitations: body.data.max_citations } : {}),
      ...(body.data.scope ? { scope: body.data.scope } : {}),
    });
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
export async function sweep(app: App): Promise<void> {
  try {
    const expired = app.actionCenter.expire();
    const resurfaced = await app.actionCenter.resurface();
    const flushed = await app.delivery.flush();
    if (expired || resurfaced || flushed) {
      logger.info({ expired, resurfaced, flushed }, "swept");
    }
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

/**
 * A cancelled or moved meeting takes its pending brief and notes nudge with it,
 * so the Inbox never holds a card about a meeting that is not happening then.
 * Settled cards are history and are left alone.
 */
export function retireMeetingCards(app: App, eventId: string, reason: string): void {
  for (const [capability, prefix] of [
    ["meeting-prep", "meeting-prep"],
    ["meeting-followup", "meeting-followup"],
  ] as const) {
    const item = getActionItemByDedupeKey(app.db, capability, `${prefix}:${eventId}`);
    if (item && ["pending", "in_review", "deferred"].includes(item.status)) {
      transition(app.db, { id: item.id, to: "expired", actor: "system", reason: `meeting ${reason}` });
    }
  }
}

export async function start(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  // Before anything touches the store: reconciliation below assumes no other
  // daemon is working on this database.
  const releaseLock = acquireInstanceLock(options.dbPath ?? loadConfig().paths.db);
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
        admissionKey: `schedule:${ctx.capabilityId}:${ctx.scheduledFor}`,
        scheduledFor: ctx.scheduledFor,
        monthlyCapUsd: app.config.billing.monthly_cap_usd,
        trigger: { mode: "scheduled", firedAt: ctx.scheduledFor },
      });
    },
  });

  // The vault watch is the Event Bus's first real listener: a note written to
  // the vault publishes onto the same bus a webhook or the `emit-event` CLI does
  // (§12 step 18). It runs here for the same reason the Scheduler does — this is
  // the one long-lived process, so it is the one that can hold a file watch open.
  const watcher = new VaultWatcher({
    roots: [
      { dir: app.config.paths.vault, kind: "note", source: "vault" },
      ...discoverJournalRoots(app.config.paths.journals),
    ],
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

  const calendarCfg = app.config.calendar;
  const calendarPoller = new CalendarPoller({
    db: app.db,
    source: calendarCfg.enabled
      ? createGoogleCalendarSource({
          account: calendarCfg.account,
          calendarId: calendarCfg.calendar_id,
        })
      : undefined,
    publish: (event) => app.eventBus.publish(event),
    onRetired: (eventId, reason) => retireMeetingCards(app, eventId, reason),
    intervalMs: calendarCfg.poll_interval_ms,
    prepLeadMinutes: calendarCfg.prep_lead_minutes,
  });

  // Telegram inbound (D5): a long poll, so no public webhook is ever needed.
  const telegram = app.config.delivery.telegram;
  const telegramPoller =
    telegram.enabled && telegram.inbound
      ? new TelegramPoller({ db: app.db, actionCenter: app.actionCenter, worker: app.worker })
      : undefined;

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
    calendarPoller.stop();
    telegramPoller?.stop();
    // Live worker runs are interrupted, not cancelled: the next boot reports them.
    app.worker.stop();
    releaseLock();
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

  if (!configuredToken()) {
    logger.warn(
      "no web:token in the Keychain: remote access is off, and any process on this Mac can approve. " +
        "Set one with: security add-generic-password -s samaritan -a web:token -w",
    );
  }
  // Tasks queued before the restart start now; ones that were running were
  // marked interrupted by reconcile() above.
  app.worker.resumeQueued();

  // Once on boot, so anything that came due while the process was down is
  // handled immediately rather than up to a minute later.
  await sweep(app);
  // The Scheduler's own catch-up (§11 case 3) then ticks on its interval. After
  // listen, so the server is answering before any catch-up run starts.
  await scheduler.start();
  // After the scheduler, so a note written during boot catch-up still fires.
  await watcher.start();
  // The Gmail and Calendar pollers last: their first poll runs at start(), so the
  // socket and in-process listeners are already up when events arrive on the bus.
  await gmailPoller.start();
  await calendarPoller.start();
  telegramPoller?.start();

  // Recall refreshes its index once now, in the background: the first run
  // downloads the local model and embeds the vault, which must not block the
  // socket. The interval timer above keeps it current from here.
  void backgroundReindex(app);

  logger.info({ url: `http://${host}:${port}` }, "samaritan api listening");
  return server;
}
