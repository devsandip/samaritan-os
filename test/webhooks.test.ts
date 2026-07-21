import { createHmac } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/api/server.js";
import { createApp, type App } from "../src/app.js";
import { repoRoot } from "../src/config/index.js";
import { __setSecretForTesting } from "../src/secrets.js";

/**
 * The Fireflies webhook end to end through the real server: disabled by default,
 * signature-gated when a secret is set, and — when it fires — a real
 * meeting.transcribed event on the real bus. The pure verify/normalise logic is
 * covered in fireflies-webhook.test.ts; this proves the wiring around it.
 */
const SECRET = "whsec_test";
const sign = (raw: string): string =>
  `sha256=${createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;

const READY = JSON.stringify({ meetingId: "m-1", eventType: "Transcription completed", title: "Sync" });

describe("POST /api/webhooks/fireflies", () => {
  let app: App;
  let server: FastifyInstance;

  const build = (enabled: boolean): void => {
    app = createApp({ dbPath: ":memory:", capabilitiesDir: join(repoRoot(), "capabilities") });
    app.config.fireflies.enabled = enabled;
    server = buildServer(app);
  };

  afterEach(async () => {
    __setSecretForTesting(`fireflies:webhook`, undefined);
    await server.close();
    app.close();
  });

  const post = (raw: string, headers: Record<string, string> = {}) =>
    server.inject({
      method: "POST",
      url: "/api/webhooks/fireflies",
      headers: { "content-type": "application/json", ...headers },
      payload: raw,
    });

  it("404s when the listener is disabled", async () => {
    build(false);
    const res = await post(READY, { "x-hub-signature-256": sign(READY) });
    expect(res.statusCode).toBe(404);
  });

  it("publishes a meeting.transcribed event for a correctly signed ready transcript", async () => {
    build(true);
    __setSecretForTesting(`fireflies:webhook`, SECRET);
    const res = await post(READY, { "x-hub-signature-256": sign(READY) });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { type: string; event_id: string; deduped: boolean };
    expect(body).toMatchObject({ type: "meeting.transcribed", event_id: "fireflies:m-1", deduped: false });
  });

  it("dedups a redelivered webhook", async () => {
    build(true);
    __setSecretForTesting(`fireflies:webhook`, SECRET);
    await post(READY, { "x-hub-signature-256": sign(READY) });
    const second = await post(READY, { "x-hub-signature-256": sign(READY) });
    expect((second.json() as { deduped: boolean }).deduped).toBe(true);
  });

  it("rejects a bad signature with 401", async () => {
    build(true);
    __setSecretForTesting(`fireflies:webhook`, SECRET);
    const res = await post(READY, { "x-hub-signature-256": "sha256=deadbeef" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing signature when a secret is configured", async () => {
    build(true);
    __setSecretForTesting(`fireflies:webhook`, SECRET);
    const res = await post(READY);
    expect(res.statusCode).toBe(401);
  });

  it("accepts unverified when no secret is configured", async () => {
    build(true); // no __setSecretForTesting → secret absent
    const res = await post(READY);
    expect(res.statusCode).toBe(202);
    expect((res.json() as { type: string }).type).toBe("meeting.transcribed");
  });

  it("202-ignores an event that is not a ready transcript", async () => {
    build(true);
    const res = await post(JSON.stringify({ meetingId: "m-2", eventType: "Meeting started" }));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ignored: true });
  });

  it("does not change how the rest of the API parses JSON", async () => {
    build(true);
    // A normal JSON route still parses normally — the raw-body parser is scoped to
    // the webhook plugin, so this ordinary route is unaffected.
    const res = await server.inject({
      method: "POST",
      url: "/api/events",
      payload: { type: "email.received", id: "probe:1", payload: { from: "x@y.com" } },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { event_id: string }).event_id).toBe("probe:1");
  });
});
