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

const cache = new Map<string, string>();

export function getSecret(account: string): string | undefined {
  const cached = cache.get(account);
  if (cached !== undefined) return cached;

  const fromEnv = process.env[envVarFor(account)];
  if (fromEnv) {
    cache.set(account, fromEnv);
    return fromEnv;
  }

  if (process.platform !== "darwin") return undefined;

  try {
    const value = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!value) return undefined;
    cache.set(account, value);
    return value;
  } catch {
    // `security` exits non-zero when the item is absent. That is a normal
    // "not configured yet" state, not an error worth a stack trace.
    logger.debug({ account }, "no keychain entry");
    return undefined;
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

/** Test seam. Never call from production code. */
export function __setSecretForTesting(account: string, value: string | undefined): void {
  if (value === undefined) cache.delete(account);
  else cache.set(account, value);
}
