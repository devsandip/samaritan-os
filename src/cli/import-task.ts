#!/usr/bin/env node
/**
 * `samaritan import-task` — turn a Claude scheduled task into a capability.
 *
 *   samaritan import-task --id morning-brief --cron "0 7 * * *" -f task.md
 *   pbpaste | samaritan import-task --id morning-brief --cron "0 7 * * *"
 *
 * A Claude scheduled task is a prompt plus a cadence, and its intelligence is
 * Claude's. So the generated capability keeps calling Claude with the same
 * instructions, verbatim, and changes only where the output lands: the Inbox
 * review gate instead of straight into Notion or TickTick. Converting the
 * prompt into a deterministic function would produce a different agent, not
 * the same one somewhere else.
 *
 * Three files come out:
 *
 *   instructions.md  the original prompt, untouched. The entrypoint reads it at
 *                    run time, so editing the prompt never means editing code.
 *   manifest.yaml    trigger, emitted type, review responses, policy.
 *   index.ts         calls Claude with the instructions and a forced output
 *                    shape, then emits whatever comes back.
 *
 * Everything it emits escalates. An imported task has never been through the
 * review gate before, so its first version has no track record to justify
 * automating anything; `escalate_when: "true"` is the honest starting point and
 * a one-line edit once it has earned better.
 *
 * See TECH-SPEC §8 for the other direction: a task still fired by Claude's own
 * scheduler registers itself by attaching a `claude_scheduled_task` source to
 * its emit, and the ownership rule keeps the in-process scheduler from
 * double-firing it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig, repoRoot } from "../config/index.js";
import { KebabId } from "../types/index.js";

interface Args {
  id: string;
  cron?: string;
  command?: string;
  instructions: string;
  attributes: string[];
  taskRef?: string;
  dir?: string;
}

const DEFAULT_ATTRIBUTES = ["title", "detail", "why_it_matters", "source_ref"];

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> & { attributes?: string[] } = {};
  let file: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--id") args.id = argv[++i];
    else if (flag === "--cron") args.cron = argv[++i];
    else if (flag === "--command") args.command = argv[++i];
    else if (flag === "--task-ref") args.taskRef = argv[++i];
    else if (flag === "--dir") args.dir = argv[++i];
    else if (flag === "--file" || flag === "-f") file = argv[++i];
    else if (flag === "--attributes" || flag === "-a") {
      args.attributes = (argv[++i] ?? "").split(",").map((a) => a.trim()).filter(Boolean);
    } else throw new Error(`unrecognised argument "${flag}"`);
  }

  if (!args.id) throw new Error("--id is required, e.g. --id morning-brief");
  if (!KebabId.safeParse(args.id).success) {
    throw new Error(`"${args.id}" is not a valid capability id. Use lowercase kebab-case.`);
  }

  const instructions = (file ? readFileSync(file, "utf8") : readFileSync(0, "utf8")).trim();
  if (!instructions) {
    throw new Error(
      "No instructions. Pipe the scheduled task's prompt on stdin, or pass --file.",
    );
  }

  for (const attribute of args.attributes ?? []) {
    if (!/^[a-z][a-z0-9_]*$/.test(attribute)) {
      throw new Error(`attribute "${attribute}" must be lower_snake_case`);
    }
  }

  return {
    id: args.id,
    instructions,
    attributes: args.attributes?.length ? args.attributes : DEFAULT_ATTRIBUTES,
    ...(args.cron ? { cron: args.cron } : {}),
    ...(args.command ? { command: args.command } : {}),
    ...(args.taskRef ? { taskRef: args.taskRef } : {}),
    ...(args.dir ? { dir: args.dir } : {}),
  };
}

const titleCase = (id: string): string =>
  id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** First non-empty line, trimmed of markdown heading and list syntax. */
function firstLine(instructions: string): string {
  const line = instructions
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>\-*\s]+/, "").trim())
    .find(Boolean);
  const summary = (line ?? "Imported from a Claude scheduled task.").replace(/\s+/g, " ");
  return summary.length > 140 ? `${summary.slice(0, 139)}…` : summary;
}

function manifestTemplate(args: Args): string {
  const trigger = args.cron
    ? `trigger:\n  mode: scheduled\n  cron: "${args.cron}"\n`
    : `trigger:\n  mode: manual\n  command: ${args.command ?? `/${args.id}`}\n`;

  const attributes = args.attributes.map((a) => `      ${a}: string`).join("\n");

  return `# ${titleCase(args.id)}
#
# Imported from a Claude scheduled task by "samaritan import-task".
# The prompt lives in instructions.md and is read at run time, so editing what
# this agent does never means editing code.
${args.taskRef ? `#\n# Claude scheduled task: ${args.taskRef}\n` : ""}
id: ${args.id}
name: ${titleCase(args.id)}
description: >-
  ${firstLine(args.instructions)}
version: 0.1.0
owner: sandip
enabled: true
entrypoint: index.ts

${trigger}
emits:
  - type: ${args.id}-review
    render:
      layout: card
      primary: ${args.attributes[0]}
      ${args.attributes[1] ? `secondary: ${args.attributes[1]}` : ""}

    custom_attributes:
${attributes}

    responses:
      - { id: approve, label: "Do it", outcome: execute }
      - { id: reject, label: "Discard", outcome: discard }
      - { id: defer, label: "Later", outcome: defer, defer_for: 1d }

    # guided.fallback renders the payload as copy-ready text and always works.
    # Point this at a real adapter once you know where the output belongs.
    execution:
      mode: guided
      capability: guided.fallback

    policy:
      # Everything escalates. This task has never been through the review gate
      # before, so it has no track record to justify automating anything yet.
      escalate_when: "true"

    priority: normal
    ttl: null

requires_capabilities:
  - guided.fallback

delivery:
  channels: [inbox]

audit: true
timeout_ms: 120000
`;
}

function entrypointTemplate(args: Args, typeImport: string): string {
  const properties = args.attributes
    .map((a) => `        ${a}: { type: "string", description: "${a.replace(/_/g, " ")}" },`)
    .join("\n");
  const custom = args.attributes.map((a) => `        ${a}: text(finding.${a}),`).join("\n");

  return `${typeImport}import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

/**
 * ${titleCase(args.id)}, imported from a Claude scheduled task.
 *
 * The prompt is read from instructions.md rather than baked in here, so the
 * thing you tune is the thing you originally wrote. The only structural
 * addition is a forced output shape: Claude has to answer through a tool whose
 * schema matches this capability's custom_attributes, which is what makes the
 * result reviewable instead of prose.
 *
 * Needs ANTHROPIC_API_KEY in the environment. Without it the run reports a
 * clear error rather than silently emitting nothing, because a scheduled
 * capability that quietly stops producing items looks exactly like a quiet
 * week.
 */

const MODEL = "claude-sonnet-5";

const REPORT_TOOL = {
  name: "report_findings",
  description:
    "Report what you found. Every finding becomes one item in Sandip's review inbox.",
  input_schema: {
    type: "object" as const,
    properties: {
      findings: {
        type: "array",
        description: "One entry per thing worth surfacing. Empty if there is nothing.",
        items: {
          type: "object",
          properties: {
${properties}
          },
          required: ${JSON.stringify(args.attributes)},
        },
      },
    },
    required: ["findings"],
  },
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export async function run(context${typeImport ? ": RunContext" : ""})${
    typeImport ? ": Promise<RunResult>" : ""
  } {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    return {
      action_items: [],
      status: "error",
      logs: ["ANTHROPIC_API_KEY is not set, so there is nothing to ask."],
    };
  }

  const instructions = readFileSync(join(import.meta.dirname, "instructions.md"), "utf8");

  const response = await new Anthropic().messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [REPORT_TOOL],
    // Forced, not suggested. A prose answer is not reviewable and would emit
    // nothing at all, which reads as "no findings" rather than as a failure.
    tool_choice: { type: "tool", name: REPORT_TOOL.name },
    messages: [
      {
        role: "user",
        content:
          instructions +
          "\\n\\nReport what you found through the report_findings tool. " +
          "If there is genuinely nothing worth surfacing, report an empty list " +
          "rather than inventing something.",
      },
    ],
  });

  const call = response.content.find((block) => block.type === "tool_use");
  const findings = (call && "input" in call
    ? ((call.input as { findings?: unknown[] }).findings ?? [])
    : []) as Record<string, unknown>[];

  const day = context.trigger.firedAt.slice(0, 10);

  const items${typeImport ? ": DraftActionItem[]" : ""} = findings.map((finding, index) => ({
    capability_id: "${args.id}",
    type: "${args.id}-review",
    context: {
      what_happened: \`${titleCase(args.id)} ran and found \${findings.length} thing(s)\`,
      source: {
        kind: "claude_scheduled_task",
        id: ${args.taskRef ? `"${args.taskRef}"` : `"${args.id}"`},
      },
      provenance: ["${args.id}.run", "claude.completion"],
      why_flagged: text(finding.${args.attributes[2] ?? args.attributes[0]}) || "surfaced by ${args.id}",
      // An LLM reading its own instructions is inference, not observation, so
      // this is in front of you for what it is rather than how sure it sounds.
      trigger_reason: "action_type",
      confidence: 0.7,
      decision_needed: "Worth acting on?",
      decision_surface: "inbox",
      execution_surface: "guided",
      outcome_preview: "Hands you the finding as copy-ready text.",
    },
    custom: {
${custom}
    },
    // Stable per day and position, so a re-run on the same day updates the
    // same items instead of stacking a second copy of the whole report.
    dedupe_key: \`${args.id}:\${day}:\${index}\`,
  }));

  return {
    action_items: items,
    status: "ok",
    logs: [\`\${items.length} finding(s) from \${MODEL}\`],
  };
}
`;
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  console.error(
    '\nUsage: samaritan import-task --id <id> [--cron "0 7 * * *"] [--file task.md]\n' +
      "                            [--attributes title,detail] [--task-ref <id>]",
  );
  process.exit(1);
}

const capabilitiesDir =
  args.dir ?? loadConfig().paths.capabilities ?? join(repoRoot(), "capabilities");
const target = join(capabilitiesDir, args.id);

if (existsSync(target)) {
  console.error(`${target} already exists. Pick another id, or delete that folder.`);
  process.exit(1);
}

const rel = relative(target, join(repoRoot(), "src", "run-layer", "context.js"));
const typeImport = `import type { DraftActionItem, RunContext, RunResult } from "${rel}";\n\n`;

mkdirSync(target, { recursive: true });
writeFileSync(join(target, "instructions.md"), `${args.instructions}\n`);
writeFileSync(join(target, "manifest.yaml"), manifestTemplate(args));
writeFileSync(join(target, "index.ts"), entrypointTemplate(args, typeImport));

console.log(`Created ${relative(process.cwd(), target) || target}/`);
console.log("  instructions.md   your prompt, verbatim");
console.log("  manifest.yaml     what it emits and how it is reviewed");
console.log("  index.ts          asks Claude, emits the answer");
console.log("\nTry it:");
console.log(`  pnpm run-capability ${args.id}`);
console.log("\nThen open the Inbox. Nothing it produces is acted on until you say so.");
if (args.cron) {
  console.log(
    `\nIt declares cron "${args.cron}" but nothing fires it yet: the scheduler is v1 ` +
      "(§12 step 17). Until then, keep the Claude task running or trigger it by hand.",
  );
}
