/**
 * Secret resolution (TECH-SPEC §6, §9).
 *
 * Secrets live in the macOS Keychain under service "samaritan", account
 * "<provider>:<account-id>". They are resolved into memory on demand, never
 * written to config.yaml, never persisted into the Action Store, and never
 * logged (the logger redacts credential-shaped keys as a backstop).
 *
 * §3 names `keytar` for this. keytar is archived and needs a native build, and
 * macOS already ships `/usr/bin/security`, which does the same job with no
 * dependency at all. Environment variables are checked first so a shell session
 * can override without touching the Keychain. See DECISIONS.md.
 */
import { execFileSync } from "node:child_process";
import { log } from "./logger.js";

const logger = log("secrets");

const SERVICE = "samaritan";

export class MissingSecretError extends Error {
  constructor(readonly account: string) {
    super(
      `no secret for "${account}". Add it with:\n` +
        `  security add-generic-password -s ${SERVICE} -a ${account} -w\n` +
        `or set ${envVarFor(account)} in the environment.`,
    );
    this.name = "MissingSecretError";
  }
}

/** `notion:pm-os-workspace` becomes `SAMARITAN_NOTION_PM_OS_WORKSPACE`. */
export function envVarFor(account: string): string {
  return `SAMARITAN_${account.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}

/**
 * Found values are re-read every few minutes, so a rotated secret (the web
 * sign-in token above all) takes effect without a restart. A miss is
 * remembered briefly too: the API asks for `web:token` on every request, and
 * spawning `security` each time would block the event loop.
 */
const FOUND_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 30_000;
const cache = new Map<string, { value: string | undefined; expiresAt: number }>();

export function getSecret(account: string): string | undefined {
  const cached = cache.get(account);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const remember = (value: string | undefined): string | undefined => {
    cache.set(account, { value, expiresAt: Date.now() + (value ? FOUND_TTL_MS : MISSING_TTL_MS) });
    return value;
  };

  const fromEnv = process.env[envVarFor(account)];
  if (fromEnv) return remember(fromEnv);

  if (process.platform !== "darwin") return remember(undefined);

  try {
    const value = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return remember(value || undefined);
  } catch {
    // `security` exits non-zero when the item is absent. That is a normal
    // "not configured yet" state, not an error worth a stack trace.
    logger.debug({ account }, "no keychain entry");
    return remember(undefined);
  }
}

export function requireSecret(account: string): string {
  const value = getSecret(account);
  if (!value) throw new MissingSecretError(account);
  return value;
}

export function hasSecret(account: string): boolean {
  return getSecret(account) !== undefined;
}

/**
 * Writes or updates a secret in the macOS Keychain (`-U`) under service
 * "samaritan" and refreshes the in-memory cache immediately.
 */
export function setSecret(account: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`secret value for "${account}" must not be empty`);
  }
  if (process.platform === "darwin") {
    execFileSync(
      "/usr/bin/security",
      ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", trimmed],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  }
  cache.set(account, { value: trimmed, expiresAt: Date.now() + FOUND_TTL_MS });
}

export function clearSecretCache(account?: string): void {
  if (account) cache.delete(account);
  else cache.clear();
}

/** Test seam. Never call from production code. */
export function __setSecretForTesting(account: string, value: string | undefined): void {
  if (value === undefined) cache.delete(account);
  else cache.set(account, { value, expiresAt: Number.POSITIVE_INFINITY });
}
