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
  });
}
