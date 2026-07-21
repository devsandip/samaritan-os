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

  recall: z
    .object({
      /**
       * §7 step 4 synthesis. Default "none" for the same reason embeddings
       * default to local: answering a question means sending the retrieved
       * passages of the vault, journals and audit trail to a third party, and
       * §9 says that is a choice Sandip makes consciously rather than a thing
       * that happens because he asked a question.
       *
       * With "none", `POST /api/recall/query` still retrieves and cites. It
       * just returns the passages instead of prose over them.
       */
      synthesis: z.enum(["none", "anthropic"]).default("none"),
      /** Keychain lookup is service "samaritan", account "anthropic:<this>". */
      account: z.string().default("default"),
      model: z.string().default("claude-sonnet-5"),
      /** How many fused chunks reach the synthesiser (§7 step 3 says ~8). */
      context_chunks: z.number().int().min(1).max(40).default(8),
    })
    .prefault({}),

  policy: z
    .object({
      /**
       * §9 risk framework. The stakes above which an item is escalated to review
       * by default rather than auto-completed, in the same unit capabilities
       * report `context.value` in (dollars or dollar-equivalent). A per-type
       * `value_threshold` in the manifest overrides this for that type.
       */
      value_threshold: z.number().min(0).default(100),
      /**
       * Whether an item marked `reversibility: "irreversible"` escalates by
       * default. A per-type `allow_irreversible: true` opts one type out. This is
       * the softer, broader default; the money-lock (§9) is separate and absolute.
       */
      escalate_irreversible: z.boolean().default(true),
    })
    .prefault({}),

  gmail: z
    .object({
      /**
       * §2.2 Gmail listener. Off by default: the poller stays idle even with a
       * token until this is set, so adding the credential does not silently start
       * pulling mail. §9 scopes the grant to read + compose, never send; the
       * token is the Keychain secret `gmail:<account>`.
       */
      enabled: z.boolean().default(false),
      account: z.string().default("default"),
      /** The Gmail search each poll runs, before its time bound. */
      query: z.string().default("in:inbox"),
      /** Poll cadence; floored at 10s so a typo cannot hammer the API. */
      poll_interval_ms: z.number().int().min(10_000).default(60_000),
      /** Initial backfill window when there is no checkpoint yet. */
      backfill_days: z.number().int().min(1).max(90).default(1),
      /** Cap on messages pulled per poll. */
      max_per_poll: z.number().int().min(1).max(100).default(25),
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

# Ask-Samaritan (§7). Retrieval is always local. "synthesis" controls whether the
# retrieved passages are also sent to an LLM to be written up as an answer:
# leave it "none" and you get the passages themselves, cited, and nothing leaves
# this machine. Set it to "anthropic" and add the key with:
#   security add-generic-password -s samaritan -a anthropic:default -w
recall:
  synthesis: none

# Risk defaults for the Policy Engine (§9). value_threshold is the stakes above
# which an item is sent to review rather than auto-completed, in whatever unit
# your capabilities report context.value in. escalate_irreversible sends anything
# marked irreversible to review by default. Money is separate and never auto.
policy:
  value_threshold: 100
  escalate_irreversible: true

# Gmail listener (§2.2). Off by default. Turn it on and add a bearer token with:
#   security add-generic-password -s samaritan -a gmail:default -w
# The grant is read + compose only (§9) — Samaritan never sends. Each poll runs
# the "query" against your mailbox and posts new mail to the Action Center, where
# it is reviewed like anything else.
gmail:
  enabled: false
  account: default
  query: "in:inbox"
  poll_interval_ms: 60000
  backfill_days: 1

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
