#!/usr/bin/env node
/**
 * `samaritan emit-event` (TECH-SPEC §12 step 18).
 *
 * Publishes one `SamaritanEvent` onto the bus. This is the manual counterpart to
 * a real listener — until the Gmail poller and the Fireflies webhook exist, it
 * is how an event reaches the event-mode agents, and it is the demo's way of
 * showing mail arriving without waiting for mail to arrive.
 *
 *   echo '{"type":"email.received","id":"gmail:1","payload":{...}}' | pnpm emit-event
 *   pnpm emit-event --file fixtures/newsletter.json --api
 *
 * Exit codes: 0 published (whether it dispatched, deduped, or matched nobody),
 * 1 could not reach the daemon or the event was malformed.
 */
import { readFileSync } from "node:fs";
import { createApp } from "../app.js";
import { SamaritanEvent } from "../events/types.js";
import type { PublishResult } from "../events/index.js";
import { apiBaseUrl } from "../sdk/index.js";

interface Args {
  file?: string;
  api: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { api: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--api") args.api = true;
    else if (flag === "--file" || flag === "-f") args.file = argv[++i];
    else throw new Error(`unrecognised argument "${flag}"`);
  }
  return args;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function report(result: PublishResult): void {
  if (result.deduped) {
    console.log(`${result.type} ${result.event_id}: already seen, dropped (no re-dispatch).`);
    return;
  }
  if (result.dispatched.length) {
    console.log(`${result.type} ${result.event_id}: dispatched to ${result.dispatched.join(", ")}.`);
  } else {
    console.log(`${result.type} ${result.event_id}: no capability subscribes to it.`);
  }
  const failed = result.matched.filter((m) => !result.dispatched.includes(m));
  if (failed.length) console.warn(`  ${failed.length} subscriber(s) failed to run: ${failed.join(", ")}`);
}

async function publishViaApi(event: SamaritanEvent): Promise<PublishResult> {
  const url = `${apiBaseUrl()}/api/events`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (err) {
    throw new Error(
      `could not reach the Action Center at ${url}. Is it running? ` +
        `Start it with "pnpm serve", or drop --api to publish in-process. (${(err as Error).message})`,
    );
  }
  const body = (await response.json()) as PublishResult & { error?: { message?: string } };
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

const source = args.file ? readFileSync(args.file, "utf8") : readStdin();
if (!source.trim()) {
  console.error(
    "No input. Pipe a SamaritanEvent JSON on stdin or pass --file.\n" +
      "  echo '{\"type\":\"email.received\",\"id\":\"gmail:1\",\"payload\":{...}}' | samaritan emit-event",
  );
  process.exit(1);
}

let parsed: unknown;
try {
  parsed = JSON.parse(source);
} catch (err) {
  console.error(`Input is not valid JSON: ${(err as Error).message}`);
  process.exit(1);
}

const event = SamaritanEvent.safeParse(parsed);
if (!event.success) {
  console.error(
    `Not a valid event: ${event.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
  );
  process.exit(1);
}

try {
  if (args.api) {
    report(await publishViaApi(event.data));
  } else {
    const app = createApp();
    try {
      report(await app.eventBus.publish(event.data));
    } finally {
      app.close();
    }
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
