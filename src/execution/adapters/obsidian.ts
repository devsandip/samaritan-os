/**
 * Obsidian vault adapters (TECH-SPEC §12 step 8).
 *
 * The vault is a folder of markdown on the same machine, so these are the only
 * v0 adapters that need no credential and cannot be "not configured". That
 * makes them the natural target for the first end-to-end smoke test.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { loadConfig } from "../../config/index.js";
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from "../../types/index.js";

/**
 * Resolves a vault-relative path, refusing anything that escapes the vault.
 * The payload reaching here came from an LLM extraction, so `../../.ssh/config`
 * is a realistic input, not a hypothetical one.
 */
export function resolveInVault(vaultRoot: string, relativePath: string): string {
  const root = resolve(vaultRoot);
  const target = resolve(root, normalize(relativePath));
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error(`path "${relativePath}" escapes the vault root`);
  }
  if (!target.endsWith(".md")) {
    throw new Error(`path "${relativePath}" is not a markdown file`);
  }
  return target;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`obsidian adapter requires a non-empty "${key}" in the payload`);
  }
  return value;
}

export const obsidianNoteCreate: ExecutionAdapter = {
  id: "obsidian.note.create",
  provider: "obsidian",
  description: "Writes a markdown note into the Obsidian vault",
  modes: ["automated", "guided"],

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const vault = loadConfig().paths.vault;
    const relative = requireString(request.payload, "path");
    const content = requireString(request.payload, "content");
    const target = resolveInVault(vault, relative);

    if (existsSync(target)) {
      return {
        status: "failed",
        error: `note already exists at ${relative}; use obsidian.note.append to add to it`,
      };
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return { status: "succeeded", result: { path: relative, absolute_path: target } };
  },

  async verify() {
    return existsSync(loadConfig().paths.vault) ? "connected" : "not_configured";
  },
};

export const obsidianNoteAppend: ExecutionAdapter = {
  id: "obsidian.note.append",
  provider: "obsidian",
  description: "Appends a block to an existing note, creating it if absent",
  modes: ["automated", "guided"],

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const vault = loadConfig().paths.vault;
    const relative = requireString(request.payload, "path");
    const content = requireString(request.payload, "content");
    const target = resolveInVault(vault, relative);

    mkdirSync(dirname(target), { recursive: true });
    const created = !existsSync(target);
    appendFileSync(target, created ? content : `\n${content}`, "utf8");
    return { status: "succeeded", result: { path: relative, created } };
  },

  async verify() {
    return existsSync(loadConfig().paths.vault) ? "connected" : "not_configured";
  },
};

/** Convenience for callers building a daily-note path. */
export function dailyNotePath(date = new Date()): string {
  const iso = date.toISOString().slice(0, 10);
  return join("Samaritan", "Areas", "Daily", `${iso}.md`);
}
