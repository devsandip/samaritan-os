/**
 * Shared Google OAuth2 token resolver for Gmail and Google Calendar (Phase 5, P5-3).
 *
 * Accepts either:
 * 1. A raw static bearer token string (returned as-is), or
 * 2. A JSON OAuth2 bundle (`{ client_id, client_secret, refresh_token, access_token?, expires_at? }`).
 *
 * When a JSON bundle is supplied, cached or pre-bundled access tokens valid for
 * at least 60 seconds are reused; expired or missing access tokens are exchanged
 * via `https://oauth2.googleapis.com/token` (`grant_type=refresh_token`).
 */
import { getSecret } from "../../secrets.js";

export interface GoogleOAuthBundle {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token?: string;
  expires_at?: number | string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function clearGoogleTokenCache(): void {
  tokenCache.clear();
}

function parseExpiresAt(raw: number | string | undefined): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Support both epoch seconds and epoch milliseconds
    return raw < 10_000_000_000 ? raw * 1000 : raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum)) {
      return asNum < 10_000_000_000 ? asNum * 1000 : asNum;
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

export async function resolveGoogleAccessToken(
  rawSecretOrAccount: string | undefined,
  opts: {
    fromKeychain?: boolean;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<string | undefined> {
  if (!rawSecretOrAccount) return undefined;
  const raw = opts.fromKeychain ? getSecret(rawSecretOrAccount) : rawSecretOrAccount;
  if (!raw) return undefined;

  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }

  const nowMs = opts.now ? opts.now() : Date.now();
  const fetchFn = opts.fetchImpl ?? fetch;

  let bundle: GoogleOAuthBundle;
  try {
    bundle = JSON.parse(trimmed) as GoogleOAuthBundle;
  } catch {
    throw new Error("invalid Google OAuth JSON bundle in secret");
  }

  if (!bundle.client_id || !bundle.client_secret || !bundle.refresh_token) {
    if (bundle.access_token) return bundle.access_token;
    throw new Error(
      "Google OAuth JSON bundle requires client_id, client_secret, and refresh_token",
    );
  }

  const cacheKey = `${bundle.client_id}:${bundle.refresh_token}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs + 60_000) {
    return cached.token;
  }

  const bundledExpiry = parseExpiresAt(bundle.expires_at);
  if (bundle.access_token && bundledExpiry && bundledExpiry > nowMs + 60_000) {
    tokenCache.set(cacheKey, { token: bundle.access_token, expiresAt: bundledExpiry });
    return bundle.access_token;
  }

  const res = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: bundle.client_id,
      client_secret: bundle.client_secret,
      refresh_token: bundle.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`google token refresh ${res.status}`);
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("google token refresh response missing access_token");
  }

  const expiresInSec = typeof json.expires_in === "number" ? json.expires_in : 3600;
  const expiresAt = nowMs + expiresInSec * 1000;
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt });
  return json.access_token;
}
