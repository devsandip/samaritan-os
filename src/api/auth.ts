/**
 * Who is calling, decided by the server (PROPOSAL D5, D9).
 *
 * Three kinds of caller reach the API, and none of them gets to say which it is:
 *
 * - **Sandip**, through the web UI on the laptop or the phone. Once a
 *   `web:token` secret exists he signs in with it once per browser and gets an
 *   HttpOnly session cookie. A bearer token works too, for curl.
 * - **A local process** on the Mac with no session: capabilities, the CLI, the
 *   MCP stdio proxy, coding-agent hooks. It may read and ingest, never decide.
 * - **Anyone else** arriving over the tailnet. Without a session they get
 *   nothing, and if no `web:token` is configured remote access is simply off.
 *
 * Decisions (approve, confirm, routing and source-rule changes, Stop) need a
 * human session as soon as a token exists, from loopback too, because an
 * assistant with a shell on this Mac can reach loopback as easily as the UI.
 * Before a token exists they stay open on loopback, as v0 was, and the daemon
 * says so at boot.
 *
 * The session cookie is an HMAC of the token, not the token, so rotating the
 * token signs every browser out (within the secret cache's few minutes).
 *
 * Two things make the gate hard to walk around:
 * - It decides on the route Fastify matched, never on the raw URL. The router
 *   decodes `%61pi/actions` to `/api/actions`; a check on the raw string would
 *   wave that through.
 * - It accepts only requests addressed to this Mac by name (127.0.0.1,
 *   localhost, or the configured public URL), and a browser POST only from one
 *   of those origins. A web page that rebinds its own domain to 127.0.0.1
 *   arrives with its own Host and is refused.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../config/index.js";
import { getSecret } from "../secrets.js";

export const SESSION_COOKIE = "samaritan_session";
const TOKEN_ACCOUNT = "web:token";

export type Caller =
  | { kind: "human"; via: "session" | "bearer" | "local-open" }
  | { kind: "local" }
  | { kind: "remote" };

function isLoopback(ip: string | undefined): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * Tailscale Serve proxies to 127.0.0.1, so a loopback address alone does not
 * mean "this Mac". The forwarding headers it adds do mean "not this Mac".
 */
export function isRemote(request: FastifyRequest): boolean {
  return (
    !isLoopback(request.ip) ||
    request.headers["x-forwarded-for"] !== undefined ||
    request.headers["tailscale-user-login"] !== undefined ||
    request.headers["x-samaritan-require-auth"] === "1"
  );
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sessionValue(token: string): string {
  return createHmac("sha256", token).update("samaritan-session-v1").digest("hex");
}

function cookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function configuredToken(): string | undefined {
  return getSecret(TOKEN_ACCOUNT);
}

export function identify(request: FastifyRequest): Caller {
  const token = configuredToken();
  if (token) {
    const auth = request.headers.authorization;
    if (auth?.toLowerCase().startsWith("bearer ") && safeEqual(auth.slice(7).trim(), token)) {
      return { kind: "human", via: "bearer" };
    }
    const session = cookie(request, SESSION_COOKIE);
    if (session && (safeEqual(session, sessionValue(token)) || safeEqual(session, token))) {
      return { kind: "human", via: "session" };
    }
  }
  if (isRemote(request)) return { kind: "remote" };
  // No token yet: the local UI keeps working without a sign-in, as before.
  return token ? { kind: "local" } : { kind: "human", via: "local-open" };
}

/** Verifies a sign-in attempt; undefined when it fails or no token is configured. */
export function checkLogin(supplied: string): string | undefined {
  const token = configuredToken();
  if (!token || !safeEqual(supplied, token)) return undefined;
  return sessionValue(token);
}

export function sessionCookieHeader(request: FastifyRequest, value: string, maxAgeDays = 30): string {
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; ` +
    `Max-Age=${maxAgeDays * 86_400}${secure}`
  );
}

/**
 * Routes that decide something, as Fastify route patterns. Only a human session
 * may call them. `test/auth.test.ts` checks every entry names a real route, so
 * a renamed route cannot silently fall out of this list.
 */
export const DECISION_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/actions/:id/respond",
  "POST /api/actions/:id/confirm",
  "POST /api/actions/:id/reopen",
  "POST /api/actions/batch",
  "PUT /api/routing/:action_type",
  "PUT /api/source-rules/:source_id",
  "POST /api/tasks/:id/cancel",
  "POST /api/tasks/:id/retry",
  "POST /api/tasks/:id/answer",
  "POST /api/runs/:id/cancel",
]);

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Names this Mac answers to: loopback, and the Tailscale name once configured. */
function allowedHost(name: string | undefined): boolean {
  if (!name) return false;
  if (LOCAL_HOSTS.has(name)) return true;
  const publicUrl = loadConfig().server.public_url;
  return Boolean(publicUrl && hostnameOf(publicUrl) === name);
}

/** The matched route as `METHOD /pattern`, or undefined when nothing matched. */
function routeKey(request: FastifyRequest): string | undefined {
  const pattern = request.routeOptions.url;
  return pattern ? `${request.method} ${pattern}` : undefined;
}

/** Routes that must load before sign-in: the SPA shell and assets, sign-in itself, signed webhooks. */
function isPublic(request: FastifyRequest): boolean {
  const pattern = request.routeOptions.url;
  if (!pattern) return false;
  if (
    pattern === "/healthz" ||
    pattern.startsWith("/api/auth/") ||
    pattern === "/api/oauth/token" ||
    pattern.startsWith("/.well-known/")
  ) {
    return true;
  }
  if (pattern.startsWith("/api/webhooks/")) return true; // each verifies its own signature
  return (request.method === "GET" || request.method === "HEAD") && !pattern.startsWith("/api/");
}

function deny(reply: FastifyReply, message: string, code = 401) {
  return reply.code(code).send({ error: { code: code === 401 ? "unauthorized" : "forbidden", message } });
}

/** The `onRequest` gate. Routing has already happened, so the matched route is known. */
export async function authGate(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  if (!allowedHost(hostnameOf(request.headers.host))) {
    return deny(reply, "unknown host", 403);
  }
  const origin = request.headers.origin;
  if (origin && request.method !== "GET" && request.method !== "HEAD" && !allowedHost(hostnameOf(origin))) {
    return deny(reply, "cross-origin request refused", 403);
  }

  const caller = identify(request);
  (request as FastifyRequest & { caller: Caller }).caller = caller;
  if (isPublic(request)) return;

  if (caller.kind === "remote") {
    return deny(
      reply,
      configuredToken()
        ? "sign in to Samaritan first"
        : "remote access is off until a web:token is set in the Keychain",
    );
  }
  const key = routeKey(request);
  if (caller.kind === "local" && key && DECISION_ROUTES.has(key)) {
    return deny(reply, "decisions need a signed-in session");
  }
  return;
}

export function callerOf(request: FastifyRequest): Caller {
  return (request as FastifyRequest & { caller?: Caller }).caller ?? identify(request);
}
