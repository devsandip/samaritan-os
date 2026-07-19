import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Every test run gets a throwaway config + state dir so tests never touch
// ~/.samaritan or the real Action Store.
const sandbox = mkdtempSync(join(tmpdir(), "samaritan-test-"));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: {
      SAMARITAN_CONFIG: join(sandbox, "config.yaml"),
      SAMARITAN_TEST_HOME: sandbox,
    },
  },
});
