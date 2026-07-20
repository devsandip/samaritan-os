import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Every test run gets a throwaway config + state dir so tests never touch
// ~/.samaritan or the real Action Store.
const sandbox = mkdtempSync(join(tmpdir(), "samaritan-test-"));
const config = join(sandbox, "config.yaml");

// The config file is written, not merely pointed at.
//
// Setting SAMARITAN_CONFIG to a path that does not exist makes loadConfig fall
// back to its defaults, and those defaults are the real ones:
// ~/Documents/Obsidian/Samaritan and ~/Developer. Any test that exercised an
// adapter which writes a file would have written it into the actual vault.
// Nothing did until the capability roster arrived, which is why this sat here
// looking like a sandbox without being one.
mkdirSync(join(sandbox, "vault"), { recursive: true });
mkdirSync(join(sandbox, "journals"), { recursive: true });
writeFileSync(
  config,
  [
    "paths:",
    `  db: ${join(sandbox, "samaritan.db")}`,
    `  vault: ${join(sandbox, "vault")}`,
    `  journals: ${join(sandbox, "journals")}`,
    "logging:",
    `  dir: ${join(sandbox, "logs")}`,
    // `capabilities` is deliberately unset: it defaults to the repo's real
    // capabilities/ folder, which is what the tests are meant to load.
    "",
  ].join("\n"),
);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: {
      SAMARITAN_CONFIG: config,
      SAMARITAN_TEST_HOME: sandbox,
      SAMARITAN_LOG_LEVEL: "silent",
    },
  },
});
