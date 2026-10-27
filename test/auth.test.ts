/**
 * Who may call what (PROPOSAL D5, D9). Remote access fails closed, decisions
 * need a signed-in human once a token exists, and the actor comes from the
 * server, never the body.
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DECISION_ROUTES } from "../src/api/auth.js";
import { buildServer } from "../src/api/server.js";
import { createApp, type App } from "../src/app.js";
import { repoRoot } from "../src/config/index.js";
import { __setSecretForTesting } from "../src/secrets.js";
import { listAuditTrail } from "../src/store/action-items.js";
import { wrapItem } from "./helpers.js";

let app: App;
let server: FastifyInstance;

beforeEach(() => {
  app = createApp({ dbPath: ":memory:", capabilitiesDir: join(repoRoot(), "capabilities") });
  server = buildServer(app);
});

afterEach(async () => {
  __setSecretForTesting("web:token", undefined);
  await server.close();
  app.close();
});

const remote = { "x-forwarded-for": "100.64.0.7" };

async function ingestWrap(): Promise<{ id: string; revision: number }> {
  const res = await app.actionCenter.ingest("wrap", [wrapItem({ dedupe_key: `wrap:auth:${Math.random()}` })]);
  return { id: res.accepted[0]!.id, revision: 1 };
}

const approve = (id: string, headers: Record<string, string> = {}) =>
  server.inject({
    method: "POST",
    url: `/api/actions/${id}/respond`,
    headers,
    payload: { response_id: "approve", expected_revision: 1, actor: "policy" },
  });

describe("without a web:token", () => {
  it("keeps the local UI working and refuses every remote caller", async () => {
    const { id } = await ingestWrap();
    expect((await approve(id)).statusCode).toBe(200);
    // The body said "policy"; the server records the human.
    expect(listAuditTrail(app.db, id).find((e) => e.to_status === "approved")?.actor).toBe("sandip");

    const fromPhone = await server.inject({ method: "GET", url: "/api/actions", headers: remote });
    expect(fromPhone.statusCode).toBe(401);
    expect(fromPhone.json().error.message).toMatch(/remote access is off/);
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { token: "anything" } });
    expect(login.statusCode).toBe(409);
  });
});

describe("with a web:token", () => {
  beforeEach(() => __setSecretForTesting("web:token", "correct horse"));

  it("lets a local process read but not decide", async () => {
    const { id } = await ingestWrap();
    expect((await server.inject({ method: "GET", url: `/api/actions/${id}` })).statusCode).toBe(200);
    const res = await approve(id);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/signed-in session/);
  });

  it("signs in with the token and decides with the session cookie, on the phone too", async () => {
    const wrong = await server.inject({ method: "POST", url: "/api/auth/login", payload: { token: "nope" } });
    expect(wrong.statusCode).toBe(401);

    const login = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { ...remote, "x-forwarded-proto": "https" },
      payload: { token: "correct horse" },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly; SameSite=Strict/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).not.toContain("correct");
    const cookie = setCookie.split(";")[0]!;

    const { id } = await ingestWrap();
    expect((await approve(id, { ...remote, cookie })).statusCode).toBe(200);
    const session = await server.inject({ method: "GET", url: "/api/auth/session", headers: { ...remote, cookie } });
    expect(session.json()).toMatchObject({ authenticated: true, token_configured: true, via: "session" });
  });

  it("accepts the token as a bearer, and serves the sign-in page to anyone", async () => {
    const { id } = await ingestWrap();
    expect((await approve(id, { authorization: "Bearer correct horse" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/", headers: remote })).statusCode).not.toBe(401);
    expect((await server.inject({ method: "GET", url: "/api/auth/session", headers: remote })).json()).toMatchObject({
      authenticated: false,
      token_configured: true,
    });
  });
});

describe("walking around the gate", () => {
  it("decides on the matched route, so a percent-encoded path gets the same answer", async () => {
    const fromPhone = await server.inject({ method: "GET", url: "/%61pi/actions", headers: remote });
    expect(fromPhone.statusCode).toBe(401);

    __setSecretForTesting("web:token", "correct horse");
    const { id } = await ingestWrap();
    const encoded = await server.inject({
      method: "POST",
      url: `/api/actions/${id}/%72espond`,
      payload: { response_id: "approve", expected_revision: 1 },
    });
    expect(encoded.statusCode).toBe(401);
  });

  it("refuses a request addressed to another host name (DNS rebinding)", async () => {
    const rebound = await server.inject({ method: "GET", url: "/api/actions", headers: { host: "evil.example:4173" } });
    expect(rebound.statusCode).toBe(403);
    const local = await server.inject({ method: "GET", url: "/api/actions", headers: { host: "127.0.0.1:4173" } });
    expect(local.statusCode).toBe(200);
  });

  it("refuses a browser POST from another origin", async () => {
    const { id } = await ingestWrap();
    const res = await approve(id, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
  });

  it("names only routes that exist", async () => {
    await server.ready();
    for (const key of DECISION_ROUTES) {
      const [method, url] = key.split(" ") as [string, string];
      expect(server.hasRoute({ method: method as "POST", url }), key).toBe(true);
    }
  });
});
