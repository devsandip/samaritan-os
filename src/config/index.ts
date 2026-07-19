/**
 * Non-secret configuration (TECH-SPEC §6).
 *
 * `~/.samaritan/config.yaml` holds port, vault path, journal glob, quiet hours,
 * log level and embedding provider — nothing else. Secrets are resolved from the
 * macOS Keychain at first use and never written here, never logged, and never
 * persisted into the Action Store (§9).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Expands a leading `~` and resolves the result to an absolute path. */
export function expandPath(input: string): string {
  const expanded = input.startsWith("~") ? join(homedir(), input.slice(1)) : input;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

const PathString = z.string().min(1).transform(expandPath);

export const ConfigSchema = z.object({
  server: z
    .object({
      /** §6: single port serving both /api/* and the SPA — one origin, no CORS. */
      port: z.number().int().min(1).max(65535).default(4173),
      /** §9: 127.0.0.1 only. Never 0.0.0.0. */
      host: z.string().default("127.0.0.1"),
    })
    .prefault({}),

  paths: z
    .object({
      db: PathString.default("~/.samaritan/samaritan.db"),
      vault: PathString.default("~/Documents/Obsidian"),
      journals: PathString.default("~/Developer"),
      capabilities: PathString.optional(),
    })
    .prefault({}),

  delivery: z
    .object({
      /** Local time window during which Delivery queues instead of pushing. */
      quiet_hours: z
        .string()
        .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'quiet_hours must look like "22:00-07:00"')
        .default("22:00-07:00"),
      telegram: z
        .object({
          enabled: z.boolean().default(false),
          chat_id: z.string().optional(),
        })
        .prefault({}),
    })
    .prefault({}),

  logging: z
    .object({
      level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
      /** §6: ~/Library/Logs/samaritan/*.log */
      dir: PathString.default("~/Library/Logs/samaritan"),
    })
    .prefault({}),

  embeddings: z
    .object({
      /**
       * §7/§9: local is the default specifically so raw text never reaches a
       * third-party API. Cloud is opt-in and must be set consciously.
       */
      provider: z.enum(["local", "openai", "voyage"]).default("local"),
      model: z.string().default("Xenova/all-MiniLM-L6-v2"),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG_YAML = `# Samaritan configuration (non-secret only).
# Secrets live in the macOS Keychain under service "samaritan" — never here.

server:
  port: 4173
  host: 127.0.0.1

paths:
  db: ~/.samaritan/samaritan.db
  vault: ~/Documents/Obsidian
  journals: ~/Developer

delivery:
  quiet_hours: "22:00-07:00"
  telegram:
    enabled: false

logging:
  level: info

embeddings:
  provider: local
`;

/** Absolute path to the repo root — the directory holding package.json. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function configPath(): string {
  return expandPath(process.env["SAMARITAN_CONFIG"] ?? "~/.samaritan/config.yaml");
}

let cached: Config | null = null;

/**
 * Loads and validates the config, writing the commented default file on first
 * run so there is always something on disk to edit.
 */
export function loadConfig(opts: { reload?: boolean } = {}): Config {
  if (cached && !opts.reload) return cached;

  const path = configPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, DEFAULT_CONFIG_YAML, "utf8");
  }

  const raw = parseYaml(readFileSync(path, "utf8")) ?? {};
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config at ${path}:\n${detail}`);
  }

  // Defaulted here rather than in the schema so it tracks the repo the code was
  // installed into instead of being baked into a user's config file.
  parsed.data.paths.capabilities ??= join(repoRoot(), "capabilities");

  cached = parsed.data;
  return cached;
}
