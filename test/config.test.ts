import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { configPath, expandPath, loadConfig } from "../src/config/index.js";

describe("expandPath", () => {
  it("expands a leading tilde to the home directory", () => {
    expect(expandPath("~/.samaritan/samaritan.db")).toBe(`${homedir()}/.samaritan/samaritan.db`);
  });

  it("leaves absolute paths alone", () => {
    expect(expandPath("/var/tmp/x")).toBe("/var/tmp/x");
  });
});

describe("loadConfig", () => {
  it("writes a default config on first run and fills in every default", () => {
    const cfg = loadConfig({ reload: true });

    expect(existsSync(configPath())).toBe(true);
    expect(cfg.server.port).toBe(4173);
    // §9: the API server must never bind anything but loopback.
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.logging.level).toBe("info");
    // §7/§9: local embeddings are the default so raw text never leaves the machine.
    expect(cfg.embeddings.provider).toBe("local");
    expect(cfg.delivery.telegram.enabled).toBe(false);
  });

  it("resolves paths to absolute and defaults capabilities to the repo folder", () => {
    const cfg = loadConfig({ reload: true });
    expect(cfg.paths.db.startsWith("/")).toBe(true);
    expect(cfg.paths.capabilities?.endsWith("/capabilities")).toBe(true);
  });

  it("expands tilde paths that come from a schema default, not just from the file", () => {
    // The generated config always writes a paths section, so the schema defaults
    // only fire for a hand-edited file that drops it. zod v4's `.default()`
    // returns its value without running the schema, so a tilde default stayed
    // literal and the Action Store landed in a directory named "~" under the
    // process cwd. Regression test for that.
    const original = readFileSync(configPath(), "utf8");
    try {
      writeFileSync(configPath(), "server:\n  port: 4173\n", "utf8");
      const cfg = loadConfig({ reload: true });

      expect(cfg.paths.db).toBe(`${homedir()}/.samaritan/samaritan.db`);
      expect(cfg.paths.vault.startsWith("~")).toBe(false);
      expect(cfg.paths.journals.startsWith("~")).toBe(false);
      expect(cfg.logging.dir.startsWith("~")).toBe(false);
    } finally {
      writeFileSync(configPath(), original, "utf8");
      loadConfig({ reload: true });
    }
  });

  it("keeps user overrides from the file", () => {
    const original = readFileSync(configPath(), "utf8");
    try {
      writeFileSync(configPath(), "server:\n  port: 5555\nlogging:\n  level: debug\n", "utf8");
      const cfg = loadConfig({ reload: true });
      expect(cfg.server.port).toBe(5555);
      expect(cfg.logging.level).toBe("debug");
      // Untouched sections still default.
      expect(cfg.server.host).toBe("127.0.0.1");
    } finally {
      writeFileSync(configPath(), original, "utf8");
      loadConfig({ reload: true });
    }
  });

  it("rejects an invalid config with a pointed error rather than silently defaulting", () => {
    const original = readFileSync(configPath(), "utf8");
    try {
      writeFileSync(configPath(), 'delivery:\n  quiet_hours: "all night"\n', "utf8");
      expect(() => loadConfig({ reload: true })).toThrow(/quiet_hours/);
    } finally {
      writeFileSync(configPath(), original, "utf8");
      loadConfig({ reload: true });
    }
  });
});
