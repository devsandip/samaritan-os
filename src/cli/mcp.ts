/**
 * Stdio entrypoint for the `samaritan` MCP server (PROPOSAL D4).
 *
 * Reads newline-delimited JSON-RPC 2.0 requests from stdin and writes responses
 * to stdout so Claude Code, Codex, and Gemini CLI can spawn it directly.
 */
import { createInterface } from "node:readline";
import { createApp } from "../app.js";
import { handleMcpRequest, type JsonRpcRequest } from "../mcp/index.js";

const app = createApp();
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const req = JSON.parse(trimmed) as JsonRpcRequest;
    const res = await handleMcpRequest(app, req);
    if (req.id !== undefined) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
    }
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: (err as Error).message },
      })}\n`,
    );
  }
});

process.on("SIGINT", () => {
  app.close();
  process.exit(0);
});
