#!/usr/bin/env node
/** `pnpm dev` / `pnpm start` - runs the API server. */
import { start } from "../api/server.js";
import { log } from "../logger.js";

const logger = log("serve");

const server = await start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    void server.close().then(() => process.exit(0));
  });
}
