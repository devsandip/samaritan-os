#!/usr/bin/env node
/**
 * `samaritan new-capability <id>` (TECH-SPEC §8, "Template").
 *
 * Scaffolds `capabilities/<id>/` with a manifest and an entrypoint already
 * wired to `context.emit()`.
 *
 *   samaritan new-capability newsletter-digest
 *   samaritan new-capability weekly-digest --mode scheduled --cron "0 20 * * 0"
 *   samaritan new-capability email-triage --mode event --on email.received
 *
 * The stub is deliberately runnable rather than a pile of TODOs: it loads, it
 * validates, and running it puts a real item in the Inbox. A scaffold that
 * fails to load teaches the author nothing about why, and the first thing
 * anyone does with a new capability is run it to see the loop close.
 *
 * It scaffolds `guided` mode against `guided.fallback` for the same reason §1
 * gives: every action type has a working guided path before it is promoted to
 * assisted or automated. Promotion is an edit to one line once the adapter
 * exists.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig, repoRoot } from "../config/index.js";
import { KebabId, type RunMode } from "../types/index.js";

interface Args {
  id: string;
  mode: RunMode;
  cron: string;
  on: string;
  command: string;
  dir?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--mode") args.mode = argv[++i] as RunMode;
    else if (flag === "--cron") args.cron = argv[++i];
    else if (flag === "--on") args.on = argv[++i];
    else if (flag === "--command") args.command = argv[++i];
    else if (flag === "--dir") args.dir = argv[++i];
    else if (!flag.startsWith("-") && !args.id) args.id = flag;
    else throw new Error(`unrecognised argument "${flag}"`);
  }
  if (!args.id) throw new Error("no capability id given");

  const parsed = KebabId.safeParse(args.id);
  if (!parsed.success) {
    throw new Error(
      `"${args.id}" is not a valid capability id. Use lowercase kebab-case, ` +
        `e.g. "newsletter-digest".`,
    );
  }

  const mode = args.mode ?? "manual";
  if (!["scheduled", "event", "manual", "continuous"].includes(mode)) {
    throw new Error(`--mode must be scheduled, event, manual or continuous (got "${mode}")`);
  }
  if (mode === "scheduled" && !args.cron) throw new Error("--mode scheduled requires --cron");
  if (mode === "event" && !args.on) throw new Error("--mode event requires --on, e.g. email.received");

  return {
    id: args.id,
    mode,
    cron: args.cron ?? "",
    on: args.on ?? "",
    command: args.command ?? `/${args.id}`,
    ...(args.dir ? { dir: args.dir } : {}),
  };
}

/** Turns "newsletter-digest" into "Newsletter Digest". */
function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function triggerBlock(args: Args): string {
  if (args.mode === "scheduled") return `trigger:\n  mode: scheduled\n  cron: "${args.cron}"\n`;
  if (args.mode === "event") return `trigger:\n  mode: event\n  on: [${args.on}]\n`;
  if (args.mode === "continuous") return `trigger:\n  mode: continuous\n`;
  return `trigger:\n  mode: manual\n  command: ${args.command}\n`;
}

function manifestTemplate(args: Args): string {
  return `# ${titleCase(args.id)} (TECH-SPEC §4.1).
#
# Scaffolded by "samaritan new-capability". This loads and runs as-is; edit it
# into the capability you actually want.

id: ${args.id}
name: ${titleCase(args.id)}
description: TODO - one line on what this capability does and when it fires.
version: 0.1.0
owner: sandip
enabled: true
entrypoint: index.ts

${triggerBlock(args)}
emits:
  - type: ${args.id}-review
    render:
      layout: card
      primary: title
      secondary: detail

    # Everything policy can read has to be declared here (§5.6). A predicate can
    # only reference an attribute that is actually on the item.
    custom_attributes:
      title: string
      detail: string

    responses:
      - { id: approve, label: "Do it", outcome: execute }
      - { id: reject, label: "Discard", outcome: discard }
      - { id: defer, label: "Later", outcome: defer, defer_for: 1d }

    # guided.fallback renders the payload as copy-ready text and always works.
    # Point this at a real adapter and raise the mode once one exists; §10
    # degrades back to guided on its own if that adapter ever goes away.
    execution:
      mode: guided
      capability: guided.fallback

    policy:
      # Escalate everything until you know which items are safe to auto-complete.
      escalate_when: "true"

    priority: normal
    ttl: null

requires_capabilities:
  - guided.fallback

delivery:
  channels: [inbox]

audit: true
timeout_ms: 60000
`;
}

function entrypointTemplate(args: Args, typeImport: string): string {
  return `${typeImport}/**
 * ${titleCase(args.id)} (TECH-SPEC §5.2).
 *
 * Scaffolded by "samaritan new-capability". Run it with:
 *
 *   pnpm run-capability ${args.id}
 *
 * Whatever this returns goes through the Action Center: validated against the
 * manifest, judged by the Policy Engine, and either auto-completed or put in
 * the Inbox for review. Nothing here writes to Notion, TickTick or anywhere
 * else directly - that is the whole point of the review gate.
 *
 * Entrypoints are imported with Node's native type stripping, which erases
 * types without transforming code. Two consequences:
 *
 *   - No enums, namespaces or parameter properties. Those need a compiler.
 *   - Relative imports of sibling files use the real ".ts" extension, not the
 *     ".js" that src/ writes. Nothing rewrites the specifier here, so "./x.js"
 *     looks for a file that does not exist. Type-only imports are exempt: they
 *     are erased before anything tries to resolve them.
 */
export async function run(context${typeImport ? ": RunContext" : ""})${
    typeImport ? ": Promise<RunResult>" : ""
  } {
  // TODO: replace this with the real work. \`context.inputs\` holds anything
  // declared under \`context.inputs\` in the manifest; \`context.trigger.payload\`
  // holds what fired the run.
  const findings = [{ title: "A thing worth your attention", detail: "Replace me." }];

  const items${typeImport ? ": DraftActionItem[]" : ""} = findings.map((finding, index) => ({
    capability_id: "${args.id}",
    type: "${args.id}-review",
    context: {
      what_happened: \`${titleCase(args.id)} ran and found \${findings.length} thing(s)\`,
      source: { kind: "${args.mode}", id: context.trigger.firedAt },
      // The path this travelled. Recall reads it to answer "why did this happen".
      provenance: ["${args.id}.run"],
      why_flagged: "TODO: why does this one need a human?",
      trigger_reason: "policy",
      confidence: 0.8,
      decision_needed: "TODO: the question you are actually being asked",
      decision_surface: "inbox",
      execution_surface: "guided",
      outcome_preview: "TODO: what approving this will do",
    },
    custom: { title: finding.title, detail: finding.detail },
    // Unique per logical event, stable across re-runs. Re-emitting the same key
    // updates the existing item instead of creating a second one (§10).
    dedupe_key: \`${args.id}:\${context.trigger.firedAt.slice(0, 10)}:\${index}\`,
  }));

  return { action_items: items, status: "ok", logs: [\`found \${items.length}\`] };
}
`;
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  console.error(
    "\nUsage: samaritan new-capability <id> [--mode scheduled|event|manual] " +
      '[--cron "0 20 * * 0"] [--on email.received] [--command /foo]',
  );
  process.exit(1);
}

const capabilitiesDir =
  args.dir ?? loadConfig().paths.capabilities ?? join(repoRoot(), "capabilities");
const target = join(capabilitiesDir, args.id);

if (existsSync(target)) {
  console.error(
    `${target} already exists. Pick another id, or delete that folder if you meant to start over.`,
  );
  process.exit(1);
}

// Type-only, so Node erases it before anything tries to resolve it. It exists
// purely so the author gets completion on `context` in their editor, which is
// worth a relative path that looks longer than it needs to.
const rel = relative(target, join(repoRoot(), "src", "run-layer", "context.js"));
const typeImport = `import type { DraftActionItem, RunContext, RunResult } from "${rel}";\n\n`;

mkdirSync(target, { recursive: true });
writeFileSync(join(target, "manifest.yaml"), manifestTemplate(args));
writeFileSync(join(target, "index.ts"), entrypointTemplate(args, typeImport));

console.log(`Created ${relative(process.cwd(), target) || target}/`);
console.log("  manifest.yaml");
console.log("  index.ts");
console.log("\nIt already works. Try it:");
console.log(`  pnpm run-capability ${args.id}`);
console.log("\nThen open the Inbox to see what it filed, and edit index.ts from there.");
