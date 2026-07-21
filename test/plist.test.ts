/**
 * The launchd plist renderer (TECH-SPEC §6, §12 step 16).
 *
 * A config-file generator's whole job is to emit exactly the right text, so the
 * tests read like the file: the two keys that make it supervision (`RunAtLoad`,
 * `KeepAlive`), the argument order that makes it run the daemon (node before the
 * entry), and the escaping that keeps a path with an ampersand from producing
 * invalid XML.
 */
import { describe, expect, it } from "vitest";
import { renderPlist, type PlistOptions } from "../src/cli/plist.js";

function opts(overrides: Partial<PlistOptions> = {}): PlistOptions {
  return {
    label: "com.sandipdev.samaritan",
    nodePath: "/usr/local/bin/node",
    entryPath: "/Users/sandipdev/Developer/samaritan/dist/cli/serve.js",
    workingDir: "/Users/sandipdev/Developer/samaritan",
    outLog: "/Users/sandipdev/Library/Logs/samaritan/daemon.out.log",
    errLog: "/Users/sandipdev/Library/Logs/samaritan/daemon.err.log",
    env: { SAMARITAN_CONFIG: "/Users/sandipdev/.samaritan/config.yaml", NODE_ENV: "production" },
    ...overrides,
  };
}

describe("renderPlist", () => {
  it("opens with the XML declaration and the plist DOCTYPE", () => {
    const xml = renderPlist(opts());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<!DOCTYPE plist PUBLIC");
    expect(xml).toContain('<plist version="1.0">');
  });

  it("supervises: RunAtLoad and KeepAlive are both set", () => {
    const xml = renderPlist(opts());
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
  });

  it("runs node against the daemon entry, node first", () => {
    const xml = renderPlist(opts());
    const node = xml.indexOf("<string>/usr/local/bin/node</string>");
    const entry = xml.indexOf(
      "<string>/Users/sandipdev/Developer/samaritan/dist/cli/serve.js</string>",
    );
    expect(node).toBeGreaterThan(-1);
    expect(entry).toBeGreaterThan(node); // argv order is [node, entry]
  });

  it("carries the config and log paths the agent needs", () => {
    const xml = renderPlist(opts());
    expect(xml).toContain(
      "<key>Label</key><string>com.sandipdev.samaritan</string>",
    );
    expect(xml).toContain(
      "<key>StandardOutPath</key><string>/Users/sandipdev/Library/Logs/samaritan/daemon.out.log</string>",
    );
    expect(xml).toContain(
      "<key>SAMARITAN_CONFIG</key><string>/Users/sandipdev/.samaritan/config.yaml</string>",
    );
  });

  it("renders env in insertion order", () => {
    const xml = renderPlist(opts({ env: { FIRST: "1", SECOND: "2" } }));
    expect(xml.indexOf("<key>FIRST</key>")).toBeLessThan(xml.indexOf("<key>SECOND</key>"));
  });

  it("escapes XML metacharacters in a path", () => {
    const xml = renderPlist(opts({ workingDir: "/Users/a&b/<x>" }));
    expect(xml).toContain("<key>WorkingDirectory</key><string>/Users/a&amp;b/&lt;x&gt;</string>");
    expect(xml).not.toContain("/Users/a&b/<x>");
  });
});
