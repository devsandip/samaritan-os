#!/usr/bin/env node
/**
 * `samaritan` MCP server over stdio (PROPOSAL D4).
 *
 * A thin proxy: each newline-delimited JSON-RPC message from stdin is posted to
 * the running daemon's `POST /api/mcp`, and the reply goes to stdout. It opens
 * no database and runs no worker, so every assistant sees the same live state
 * and a task submitted here keeps running after the assistant exits.
 *
 * Stdout carries JSON-RPC and nothing else. That is why this file imports no
 * logger and reads the port straight from config: a single stray log line on
 * stdout breaks the client's parser.
 *
 * Register it as `node <repo>/dist/cli/mcp.js` (after `pnpm build`). `pnpm mcp`
 * works for a manual check, but pnpm prints its own lines first.
 */
import { createInterface } from "node:readline";
import { loadConfig } from "../config/index.js";

const config = loadConfig();
const endpoint = `http://127.0.0.1:${config.server.port}/api/mcp`;

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function forward(line: string): Promise<void> {
  let message: { id?: unknown };
  try {
    message = JSON.parse(line) as { id?: unknown };
  } catch (err) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: (err as Error).message } });
    return;
  }
  if (!message || typeof message !== "object") {
    write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: expected an object" } });
    return;
  }
  const id = Array.isArray(message) ? null : (message.id ?? null);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-samaritan-client": "mcp-stdio" },
      body: line,
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 202) return; // a notification: nothing to send back
    const text = await res.text();
    if (!res.ok) {
      write({ jsonrpc: "2.0", id, error: { code: -32603, message: `daemon replied ${res.status}: ${text}` } });
      return;
    }
    process.stdout.write(`${text.trim()}\n`);
  } catch (err) {
    if (message.id === undefined) return;
    write({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message:
          `Samaritan's daemon is not reachable at ${endpoint} (${(err as Error).message}). ` +
          `Start it with "pnpm install-daemon" or "pnpm serve".`,
      },
    });
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
let queue = Promise.resolve();
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  // Keep replies in request order; clients tolerate either, people reading logs do not.
  // A failure in one message must not stop the ones after it.
  queue = queue.then(() => forward(trimmed)).catch(() => undefined);
});
rl.on("close", () => {
  void queue.then(() => process.exit(0));
});
process.stdout.on("error", () => process.exit(0)); // client went away (EPIPE)
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
