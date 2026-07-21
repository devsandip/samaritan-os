/**
 * The HTTP surface (TECH-SPEC §5.1).
 *
 * Everything below runs through `inject`, so it exercises the real routes,
 * schemas and error handler without binding a port. The layer had no coverage at
 * all, which is how a crash on boot got through a green suite once already.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/api/server.js";
import { createApp, type App } from "../src/app.js";
import { repoRoot } from "../src/config/index.js";
import { transition } from "../src/store/action-items.js";
import { DISMISS_RESPONSE_ID, type ActionItemStatus } from "../src/types/index.js";
import { wrapItem } from "./helpers.js";

let app: App;
let server: FastifyInstance;

beforeEach(() => {
  app = createApp({
    dbPath: ":memory:",
    capabilitiesDir: join(repoRoot(), "capabilities"),
  });
  server = buildServer(app);
});

afterEach(async () => {
  await server.close();
  app.close();
});

/** Ingests one wrap item and returns its id. */
async function ingest(dedupeKey: string): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/api/actions",
    payload: { capability_id: "wrap", items: [wrapItem({ dedupe_key: dedupeKey })] },
  });
  expect(response.statusCode).toBe(202);
  const body = response.json() as { accepted: { id: string }[]; rejected: unknown[] };
  expect(body.rejected).toEqual([]);
  return body.accepted[0]!.id;
}

async function list(queryString: string): Promise<{ id: string; status: ActionItemStatus }[]> {
  const response = await server.inject({ method: "GET", url: `/api/actions${queryString}` });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: { id: string; status: ActionItemStatus }[] }).items;
}

/** One item in each of the statuses the Inbox and Completed views span. */
async function spread(): Promise<Record<string, string>> {
  const ids = {
    pending: await ingest("wrap:a:0"),
    in_review: await ingest("wrap:b:0"),
    rejected: await ingest("wrap:c:0"),
    executed: await ingest("wrap:d:0"),
  };
  transition(app.db, { id: ids.in_review, to: "in_review", actor: "sandip", reason: "opened" });
  transition(app.db, { id: ids.rejected, to: "rejected", actor: "sandip", reason: "no" });
  transition(app.db, { id: ids.executed, to: "approved", actor: "sandip", reason: "yes" });
  transition(app.db, { id: ids.executed, to: "executed", actor: "system", reason: "filed" });
  return ids;
}

describe("GET /api/actions", () => {
  it("filters on one status", async () => {
    const ids = await spread();
    const items = await list("?status=pending");
    expect(items.map((i) => i.id)).toEqual([ids.pending]);
  });

  it("filters on several, in one request", async () => {
    const ids = await spread();

    // The Inbox spans four statuses. It used to issue one request per status and
    // concatenate, which applied `limit` per status rather than to the answer.
    const items = await list("?status=pending&status=in_review");
    expect(new Set(items.map((i) => i.id))).toEqual(new Set([ids.pending, ids.in_review]));
  });

  it("applies limit to the whole result, not per status", async () => {
    await spread();
    const items = await list("?status=pending&status=in_review&status=rejected&limit=2");
    expect(items).toHaveLength(2);
  });

  it("returns everything when no status is given", async () => {
    await spread();
    expect(await list("")).toHaveLength(4);
  });

  it("rejects an unknown status rather than ignoring it", async () => {
    const response = await server.inject({ method: "GET", url: "/api/actions?status=banana" });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("rejects an unknown status mixed in with valid ones", async () => {
    // Silently dropping the bad one would answer a question nobody asked.
    const response = await server.inject({
      method: "GET",
      url: "/api/actions?status=pending&status=banana",
    });
    expect(response.statusCode).toBe(400);
  });

  it("orders by priority then recency, which a client-side merge could not", async () => {
    await ingest("wrap:normal:0");
    const urgentId = await ingest("wrap:urgent:0");
    transition(app.db, {
      id: urgentId,
      to: "pending",
      actor: "policy",
      reason: "raised",
      patch: { priority: "urgent" },
    });

    const items = await list("?status=pending&status=in_review");
    expect(items[0]!.id).toBe(urgentId);
  });
});

describe("the item routes", () => {
  it("404s an unknown id on both the item and its audit trail", async () => {
    for (const url of ["/api/actions/nope", "/api/actions/nope/audit"]) {
      const response = await server.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect((response.json() as { error: { code: string } }).error.code).toBe("not_found");
    }
  });

  it("carries an ActionCenterError's own status and code through", async () => {
    const id = await ingest("wrap:e:0");
    const response = await server.inject({
      method: "POST",
      url: `/api/actions/${id}/respond`,
      payload: { response_id: "not-a-thing" },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "response_not_allowed",
    );
  });

  it("turns an illegal transition into a 409 rather than a 500", async () => {
    const id = await ingest("wrap:f:0");
    transition(app.db, { id, to: "approved", actor: "sandip", reason: "yes" });
    transition(app.db, { id, to: "executed", actor: "system", reason: "filed" });

    const response = await server.inject({
      method: "POST",
      url: `/api/actions/${id}/respond`,
      payload: { response_id: DISMISS_RESPONSE_ID },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe("illegal_transition");
  });

  it("accepts the universal dismiss over HTTP", async () => {
    const id = await ingest("wrap:g:0");
    const response = await server.inject({
      method: "POST",
      url: `/api/actions/${id}/respond`,
      payload: { response_id: DISMISS_RESPONSE_ID },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe("rejected");
  });

  it("rejects a malformed body with the field that was wrong", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/actions",
      payload: { capability_id: "wrap" },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toContain("items");
  });
});

describe("GET /api/capabilities", () => {
  interface CapabilityView {
    id: string;
    next_fire_at: string | null;
    last_run_status: string | null;
  }

  async function capabilities(): Promise<CapabilityView[]> {
    const response = await server.inject({ method: "GET", url: "/api/capabilities" });
    expect(response.statusCode).toBe(200);
    return (response.json() as { capabilities: CapabilityView[] }).capabilities;
  }

  it("carries next_fire_at, null until the scheduler has armed a trigger", async () => {
    const digest = (await capabilities()).find((c) => c.id === "weekly-digest");
    expect(digest).toBeDefined();
    // buildServer does not run the scheduler, so nothing has been armed yet.
    expect(digest!.next_fire_at).toBeNull();
  });

  it("reflects the next_fire_at the scheduler persisted on the trigger row", async () => {
    const when = new Date("2026-07-26T20:00:00.000Z").toISOString();
    app.db
      .prepare("UPDATE triggers SET next_fire_at = ? WHERE capability_id = 'weekly-digest'")
      .run(when);

    const digest = (await capabilities()).find((c) => c.id === "weekly-digest");
    expect(digest!.next_fire_at).toBe(when);
  });
});

describe("/healthz", () => {
  it("reports the loaded capabilities so a boot problem is visible", async () => {
    // Counted from the folder rather than hardcoded. The number is not the
    // claim: the claim is that every capability on disk loaded and none of them
    // reported a problem, and a literal here fails on the day someone adds one.
    const onDisk = readdirSync(join(repoRoot(), "capabilities"), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    ).length;

    const response = await server.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", capabilities: onDisk, problems: 0 });
  });
});
