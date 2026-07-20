#!/usr/bin/env node
/**
 * `samaritan run-capability <id>` (TECH-SPEC §12 step 14, §8).
 *
 * Fires one capability by hand. This is what a Claude scheduled task or a slash
 * command shells out to until the v1 scheduler owns firing, and what a human
 * uses to check that a capability they just wrote does what they meant.
 *
 *   samaritan run-capability weekly-digest
 *   samaritan run-capability newsletter-digest --input-file fixtures/demo.json
 *   samaritan run-capability wrap --api        # against the running daemon
 *
 * Exit codes: 0 ran and every item was accepted, 1 the run failed, 2 the run
 * succeeded but some items were rejected at ingest.
 */
import { readFileSync } from "node:fs";
import { createApp } from "../app.js";
import { runCapability, type RunReport } from "../run-layer/index.js";
import { apiBaseUrl } from "../sdk/index.js";

interface Args {
  id?: string;
  inputs: Record<string, unknown>;
  force: boolean;
  api: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { inputs: {}, force: false, api: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--force") args.force = true;
    else if (flag === "--api") args.api = true;
    else if (flag === "--input-file" || flag === "-f") {
      const parsed: unknown = JSON.parse(readFileSync(argv[++i]!, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("--input-file must contain a JSON object of input keys");
      }
      Object.assign(args.inputs, parsed);
    } else if (flag === "--input" || flag === "-i") {
      // `--input email.message=@msg.json` reads the value from a file; anything
      // else is taken literally. Inputs are usually payloads, not scalars.
      const [key, ...rest] = (argv[++i] ?? "").split("=");
      const value = rest.join("=");
      if (!key || !value) throw new Error('--input expects "key=value"');
      args.inputs[key] = value.startsWith("@")
        ? JSON.parse(readFileSync(value.slice(1), "utf8"))
        : value;
    } else if (!flag.startsWith("-") && !args.id) args.id = flag;
    else throw new Error(`unrecognised argument "${flag}"`);
  }
  return args;
}

function report(result: RunReport): number {
  const { status, capability_id: id } = result;
  console.log(`${id}: ${status} in ${result.duration_ms}ms`);

  if (result.error) console.error(`  ${result.error}`);
  for (const line of result.logs) console.log(`  log: ${line}`);
  if (result.missing_inputs.length) {
    console.warn(
      `  warning: declared inputs not supplied: ${result.missing_inputs.join(", ")}. ` +
        `Pass them with --input or --input-file.`,
    );
  }

  if (result.accepted.length) {
    const pending = result.accepted.filter((a) => a.status === "pending");
    console.log(`  ${result.accepted.length} item(s) accepted:`);
    for (const item of result.accepted) console.log(`    ${item.id}  ${item.status}`);
    if (pending.length) console.log(`  ${pending.length} waiting for you in the Inbox.`);
  } else if (status === "ok") {
    console.log("  no items emitted");
  }

  if (result.rejected.length) {
    console.error(`  ${result.rejected.length} item(s) rejected at ingest:`);
    for (const item of result.rejected) console.error(`    ${item.errors.join("; ")}`);
    return 2;
  }
  return status === "ok" ? 0 : 1;
}

/** Runs against the daemon rather than opening the store a second time. */
async function runViaApi(args: Args): Promise<RunReport> {
  const url = `${apiBaseUrl()}/api/capabilities/${args.id}/run`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: args.inputs, force: args.force }),
    });
  } catch (err) {
    throw new Error(
      `could not reach the Action Center at ${url}. Is it running? ` +
        `Start it with "pnpm serve", or drop --api to run in-process. (${(err as Error).message})`,
    );
  }
  const body = (await response.json()) as RunReport & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? response.statusText);
  return body;
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

if (!args.id) {
  console.error(
    "Usage: samaritan run-capability <id> [--input key=value] [--input-file f.json] [--force] [--api]",
  );
  process.exit(1);
}

try {
  if (args.api) {
    process.exit(report(await runViaApi(args)));
  }
  const app = createApp();
  try {
    process.exit(
      report(await runCapability(app, args.id, { inputs: args.inputs, force: args.force })),
    );
  } finally {
    app.close();
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
