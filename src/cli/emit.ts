#!/usr/bin/env node
/**
 * `samaritan emit` (TECH-SPEC §8, §12 step 14).
 *
 * The bridge the wrap and meeting skills call instead of writing to Notion and
 * TickTick directly. Reads a JSON payload on stdin, posts it to the Action
 * Center, and prints a report the calling skill can relay to Sandip verbatim.
 *
 *   echo '{"capability_id":"wrap","items":[...]}' | pnpm emit
 *   pnpm emit --capability wrap --file items.json
 *
 * Exit codes: 0 all accepted, 1 could not reach the Action Center or the
 * payload was malformed, 2 some items were rejected.
 */
import { readFileSync } from "node:fs";
import { emit, EmitError } from "../sdk/index.js";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseArgs(argv: string[]): { capability?: string; file?: string } {
  const args: { capability?: string; file?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--capability" || flag === "-c") args.capability = argv[++i];
    else if (flag === "--file" || flag === "-f") args.file = argv[++i];
  }
  return args;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const source = args.file ? readFileSync(args.file, "utf8") : readStdin();
if (!source.trim()) {
  fail(
    "No input. Pipe JSON on stdin or pass --file.\n" +
      '  echo \'{"capability_id":"wrap","items":[...]}\' | samaritan emit',
  );
}

let parsed: unknown;
try {
  parsed = JSON.parse(source);
} catch (err) {
  fail(`Input is not valid JSON: ${(err as Error).message}`);
}

const payload = parsed as { capability_id?: string; items?: unknown };
const capabilityId = args.capability ?? payload.capability_id;
if (!capabilityId) fail("No capability id. Pass --capability or include capability_id in the JSON.");

const items = Array.isArray(payload.items) ? payload.items : Array.isArray(parsed) ? parsed : null;
if (!items || items.length === 0) fail('No items. Expected {"items": [...]} or a bare JSON array.');

try {
  const result = await emit(capabilityId, items as Record<string, unknown>[]);

  const escalated = result.accepted.filter((a) => a.status === "pending");
  const auto = result.accepted.filter((a) => a.status !== "pending");

  console.log(
    `Emitted ${result.accepted.length}/${items.length} item(s) from "${capabilityId}".`,
  );
  if (escalated.length) {
    console.log(`\n${escalated.length} awaiting review in the Inbox:`);
    for (const a of escalated) console.log(`  ${a.id}  ${a.policy?.reason ?? ""}`);
  }
  if (auto.length) {
    console.log(`\n${auto.length} auto-completed by policy:`);
    for (const a of auto) console.log(`  ${a.id}  ${a.status}`);
  }
  if (result.rejected.length) {
    console.error(`\n${result.rejected.length} rejected:`);
    for (const r of result.rejected) console.error(`  ${r.errors.join("; ")}`);
    process.exit(2);
  }
} catch (err) {
  if (err instanceof EmitError) fail(err.message);
  throw err;
}
