#!/usr/bin/env node
/**
 * `samaritan seed` — a full Inbox on day one.
 *
 *   samaritan seed                 # fill the Inbox
 *   samaritan seed --only wrap     # one capability
 *   samaritan seed --clear         # resolve what a previous seed left open
 *   samaritan seed --list          # what would run, and what it demonstrates
 *   samaritan seed --no-act        # leave every item pending
 *   samaritan seed --force         # re-run capabilities already seeded
 *
 * The work is in src/seed/index.ts; this parses flags and prints. Everything it
 * creates goes through the real Run Layer and Action Center, so a seeded item
 * and a real one are the same thing.
 */
import { createApp } from "../app.js";
import { runSeed, seedable, type RunReportEntry } from "../seed/index.js";

interface Args {
  only: string[];
  clear: boolean;
  list: boolean;
  act: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { only: [], clear: false, list: false, act: true, force: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--clear") args.clear = true;
    else if (flag === "--list") args.list = true;
    else if (flag === "--no-act") args.act = false;
    else if (flag === "--force") args.force = true;
    else if (flag === "--only" || flag === "-o") args.only.push(argv[++i]!);
    else if (!flag.startsWith("-")) args.only.push(flag);
    else throw new Error(`unrecognised argument "${flag}"`);
  }
  return args;
}

function summarise({ target, report }: RunReportEntry): void {
  const pending = report.accepted.filter((a) => a.status === "pending").length;
  const auto = report.accepted.filter((a) => a.status === "executed").length;
  const other = report.accepted.length - pending - auto;

  const parts: string[] = [];
  if (pending) parts.push(`${pending} to review`);
  if (auto) parts.push(`${auto} handled automatically`);
  if (other) parts.push(`${other} elsewhere`);
  if (!parts.length) parts.push("nothing emitted");

  const failed = report.status === "ok" ? "" : `  [${report.status}: ${report.error}]`;
  console.log(`  ${target.id.padEnd(22)} ${parts.join(", ")}${failed}`);
  for (const rejected of report.rejected) {
    console.error(`    rejected: ${rejected.errors.join("; ")}`);
  }
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  console.error("\nUsage: samaritan seed [--only <id>] [--clear] [--list] [--no-act] [--force]");
  process.exit(1);
}

const app = createApp();
try {
  const targets = seedable(app, args.only);

  if (!targets.length) {
    console.error(
      args.only.length
        ? `No seedable capability matched ${args.only.join(", ")}.`
        : "No capability ships a fixtures/demo.json, so there is nothing to seed.",
    );
    process.exit(1);
  }

  if (args.list) {
    console.log(`${targets.length} capability(ies) can be seeded:\n`);
    for (const target of targets) {
      console.log(`  ${target.id}`);
      if (target.note) console.log(`    ${target.note}\n`);
    }
    process.exit(0);
  }

  const result = await runSeed(app, {
    only: args.only,
    clear: args.clear,
    act: args.act,
    force: args.force,
  });

  if (args.clear) {
    console.log(
      `Cleared ${result.cleared} open item(s). The audit trail keeps them; the Inbox does not.\n`,
    );
  }

  console.log(`Seeding from ${targets.length} capability(ies):\n`);
  for (const entry of result.reports) summarise(entry);
  for (const id of result.skipped) {
    console.log(`  ${id.padEnd(22)} already seeded, skipped`);
  }
  if (result.skipped.length && !result.reports.length) {
    console.log("\nNothing new to seed. Use --force to run them again, or --clear first.");
  }

  if (result.acted.length) {
    console.log("\nAnswered a few, so the other views are not empty:");
    for (const line of result.acted) console.log(`  ${line}`);
  }

  console.log(`\n${result.inboxCount} item(s) waiting in the Inbox.`);
  console.log(`Open it: http://${app.config.server.host}:${app.config.server.port}/`);
  process.exit(result.failures ? 2 : 0);
} finally {
  app.close();
}
