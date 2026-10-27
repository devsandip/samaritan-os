/**
 * Inbound webhook routes (TECH-SPEC §2.2, §9).
 *
 * Registered as an encapsulated Fastify plugin for one specific reason: a webhook
 * signature is an HMAC over the *exact bytes* the sender posted, so these routes
 * need the raw body, and the way to read it is a `parseAs: "string"` content-type
 * parser. Fastify's content-type parsers are per-plugin, so putting the webhooks
 * in their own `register` keeps that raw-body parser scoped to them — every other
 * route on the server still uses the default JSON parser, unchanged.
 *
 * The trust model is §9's. The API is loopback-only with no auth in v0, but a
 * webhook is inbound by definition and only reaches the daemon through a tunnel,
 * which is exactly the case §9 says needs a check in front. So when a signing
 * secret is configured the signature is required; without one the route still
 * works for local testing but logs that it is unverified.
 */
import type { FastifyInstance } from "fastify";
import type { App } from "../app.js";
import {
  firefliesEventToSamaritan,
  verifyFirefliesSignature,
  type FirefliesWebhookBody,
} from "../events/listeners/fireflies-webhook.js";
import {
  slackEventToSamaritan,
  verifySlackSignature,
  type SlackWebhookBody,
} from "../events/listeners/slack-webhook.js";
import { log } from "../logger.js";
import { getSecret } from "../secrets.js";

const logger = log("webhooks");

export function registerWebhooks(server: FastifyInstance, app: App): void {
  void server.register(async (instance) => {
    // Keep the exact bytes so the HMAC matches, then still JSON-parse so the
    // handler gets `request.body` as usual. An empty body becomes `undefined`
    // rather than a parse error, since a signature check can precede any body.
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (req, body, done) => {
        (req as unknown as { rawBody: string }).rawBody = body as string;
        if (body === "") return done(null, undefined);
        try {
          done(null, JSON.parse(body as string));
        } catch (err) {
          done(err as Error);
        }
      },
    );

    /**
     * Fireflies posts here when a meeting transcript is ready. A disabled listener
     * 404s (nothing to find); a bad signature 401s; a body that is not a ready
     * transcript is a 202 "ignored", so Fireflies does not retry a message we
     * chose not to act on. A real one becomes a `meeting.transcribed` event, and
     * the response reports what the bus did with it (dispatched / deduped).
     */
    instance.post("/api/webhooks/fireflies", async (request, reply) => {
      const cfg = app.config.fireflies;
      if (!cfg.enabled) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "fireflies webhook disabled" } });
      }

      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? "";
      const secret = getSecret(`fireflies:${cfg.account}`);
      if (secret) {
        const signature = (request.headers["x-hub-signature-256"] ??
          request.headers["x-hub-signature"]) as string | undefined;
        if (!verifyFirefliesSignature(secret, rawBody, signature)) {
          logger.warn("rejected fireflies webhook: bad signature");
          return reply.code(401).send({ error: { code: "unauthorized", message: "bad signature" } });
        }
      } else {
        logger.warn(
          { account: cfg.account },
          "fireflies webhook secret not set; accepting unverified",
        );
      }

      const event = firefliesEventToSamaritan((request.body ?? {}) as FirefliesWebhookBody);
      if (!event) return reply.code(202).send({ ignored: true });
      return reply.code(202).send(await app.eventBus.publish(event));
    });

    /**
     * Slack Events API inbound webhook (TECH-SPEC §2.2, §12 step 18).
     * Handles `url_verification` challenges and `event_callback` events.
     */
    instance.post("/api/webhooks/slack", async (request, reply) => {
      const cfg = app.config.slack;
      if (!cfg.enabled) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "slack webhook disabled" } });
      }

      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? "";
      const secret = getSecret(`slack:${cfg.account}`);
      if (secret) {
        const tsHeader = request.headers["x-slack-request-timestamp"] as string | undefined;
        const sigHeader = request.headers["x-slack-signature"] as string | undefined;
        if (!verifySlackSignature(secret, rawBody, tsHeader, sigHeader)) {
          logger.warn("rejected slack webhook: bad signature");
          return reply.code(401).send({ error: { code: "unauthorized", message: "bad signature" } });
        }
      } else {
        logger.warn({ account: cfg.account }, "slack webhook secret not set; accepting unverified");
      }

      const body = (request.body ?? {}) as SlackWebhookBody;
      if (body.type === "url_verification") {
        return reply.code(200).send({ challenge: body.challenge ?? "" });
      }

      const event = slackEventToSamaritan(body);
      if (!event) return reply.code(202).send({ ignored: true });
      return reply.code(202).send(await app.eventBus.publish(event));
    });

    /**
     * Apple Shortcuts / geofence webhook when arriving at office (PROPOSAL P3-1).
     */
    instance.post("/api/webhooks/arrival", async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const location = typeof body.location === "string" ? body.location : "office";
      const arrivedAt =
        typeof body.arrived_at === "string" ? body.arrived_at : new Date().toISOString();
      const event = {
        id: `arrival:${location}:${arrivedAt.slice(0, 10)}`,
        type: "location.office_arrived",
        source: "apple.shortcuts",
        occurred_at: arrivedAt,
        payload: { location, arrived_at: arrivedAt, ...body },
      };
      return reply.code(202).send(await app.eventBus.publish(event));
    });

    /**
     * Hevy / Apple Shortcuts post-workout completion webhook (PROPOSAL P3-1).
     */
    instance.post("/api/webhooks/hevy", async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const workoutId =
        typeof body.workout_id === "string"
          ? body.workout_id
          : typeof body.id === "string"
            ? body.id
            : `hevy-${Date.now()}`;
      const title =
        typeof body.title === "string" ? body.title : "Hevy Workout Session";
      const completedAt =
        typeof body.completed_at === "string" ? body.completed_at : new Date().toISOString();
      const event = {
        id: `hevy:workout:${workoutId}`,
        type: "workout.completed",
        source: "hevy.webhook",
        occurred_at: completedAt,
        payload: { workout_id: workoutId, title, completed_at: completedAt, ...body },
      };
      return reply.code(202).send(await app.eventBus.publish(event));
    });

    /**
     * Thornhill mid-call stop-point escalation webhook (PROPOSAL D7, P4-1).
     */
    instance.post("/api/webhooks/thornhill", async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const callId =
        typeof body.call_id === "string" ? body.call_id : `call-${Date.now()}`;
      const stopReason =
        typeof body.stop_reason === "string" ? body.stop_reason : "approval_needed";
      const event = {
        id: `thornhill:stop:${callId}:${stopReason}`,
        type: "phone.stop_point_reached",
        source: "thornhill",
        occurred_at: new Date().toISOString(),
        payload: {
          call_id: callId,
          callee_name: String(body.callee_name ?? "Callee"),
          phone_number: String(body.phone_number ?? ""),
          stop_reason: stopReason,
          question: String(body.question ?? "Stop-point reached during call; how should Thornhill proceed?"),
          ...body,
        },
      };
      return reply.code(202).send(await app.eventBus.publish(event));
    });
  });
}
