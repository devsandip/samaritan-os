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

/**
 * Defaults for path fields must use `prefault`, never `default`.
 *
 * zod v4's `.default()` short-circuits: it hands back the literal default
 * without running the schema, so `expandPath` never sees it and a `~` stays a
 * `~`. Anything that then opens the path creates a directory literally named
 * "~" under the process's cwd. `.prefault()` feeds the value through the schema
 * like real input, which is what a tilde path needs.
 */
const PathDefault = (path: string) => PathString.prefault(path);

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
      db: PathDefault("~/.samaritan/samaritan.db"),
      // The vault root is the Samaritan folder itself, not its parent. The
      // skills' system contract has always said so, and pointing at the parent
      // writes notes into a sibling of the vault where nothing will find them.
      vault: PathDefault("~/Documents/Obsidian/Samaritan"),
      journals: PathDefault("~/Developer"),
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
      dir: PathDefault("~/Library/Logs/samaritan"),
    })
    .prefault({}),

  notion: z
    .object({
      /** Keychain lookup is service "samaritan", account "notion:<this>". */
      account: z.string().default("pm-os-workspace"),
      /**
       * Database ids, set per-install in config.yaml. Deliberately empty here:
       * these identify a specific private Notion workspace, so they are local
       * configuration rather than something baked into the repo. An unset id
       * fails loudly at execute() instead of writing to the wrong database.
       *
       * These are Notion *database* ids, which is what the REST API's
       * `parent.database_id` takes. Notion also issues a separate *data source*
       * id for the same table, which is what the Notion MCP tool wants. They are
       * different values and are not interchangeable.
       */
      databases: z
        .object({
          decisions: z.string().default(""),
          insights: z.string().default(""),
          people: z.string().default(""),
          projects: z.string().default(""),
        })
        .prefault({}),
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
  vault: ~/Documents/Obsidian/Samaritan
  journals: ~/Developer

delivery:
  quiet_hours: "22:00-07:00"
  telegram:
    enabled: false

logging:
  level: info

embeddings:
  provider: local

# Notion database ids for your own workspace. Find one in the database's URL:
# notion.so/<workspace>/<32-hex-id>?v=... Leave blank to disable that target.
notion:
  account: pm-os-workspace
  databases:
    decisions: ""
    insights: ""
    people: ""
    projects: ""
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
