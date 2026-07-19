import { pino } from "pino";
import { loadConfig } from "./config/index.js";

const isProduction = process.env["NODE_ENV"] === "production";

/**
 * Structured logger. §9 requires that secrets never reach the logs, so anything
 * carrying a credential-shaped key is redacted at the serializer rather than
 * relying on call sites to remember.
 */
export const logger = pino({
  // The env override exists so tests and one-off CLI runs can silence output
  // without editing the user's config file.
  level: process.env["SAMARITAN_LOG_LEVEL"] ?? loadConfig().logging.level,
  redact: {
    paths: [
      "*.token",
      "*.access_token",
      "*.refresh_token",
      "*.api_key",
      "*.apiKey",
      "*.password",
      "*.secret",
      "*.authorization",
      'req.headers["authorization"]',
    ],
    censor: "[redacted]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
});

/** Child logger tagged with the component name, e.g. `log("policy")`. */
export function log(component: string) {
  return logger.child({ component });
}
