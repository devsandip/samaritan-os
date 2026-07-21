#!/usr/bin/env node
/**
 * Installs the launchd agent that supervises the daemon (TECH-SPEC §6, §12 step
 * 16). `pnpm install-daemon` writes the plist; `--print` renders it to stdout
 * without touching disk, so it can be reviewed anywhere (and on this Linux box).
 *
 * The effect half of the split: it resolves the real paths this machine needs —
 * the running `node`, the built entry, the config, the log directory — and hands
 * them to the pure renderPlist(). It does not start anything; launchctl does, and
 * the command to do so is printed rather than run, because loading an agent is a
 * one-time deliberate act, not a side effect of generating its config.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "../config/index.js";
import { renderPlist } from "./plist.js";

const LABEL = "com.sandipdev.samaritan";

function main(): void {
  const print = process.argv.includes("--print");
  const home = homedir();
  const root = repoRoot();
  // The production daemon runs the built JS (`pnpm start`), not tsx, so the agent
  // points node at dist/. `pnpm build` must have produced it before load.
  const entryPath = join(root, "dist", "cli", "serve.js");
  const configPath = process.env.SAMARITAN_CONFIG ?? join(home, ".samaritan", "config.yaml");
  const logDir = join(home, "Library", "Logs", "samaritan");
  const plistPath = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

  const plist = renderPlist({
    label: LABEL,
    nodePath: process.execPath,
    entryPath,
    workingDir: root,
    outLog: join(logDir, "daemon.out.log"),
    errLog: join(logDir, "daemon.err.log"),
    env: { SAMARITAN_CONFIG: configPath, NODE_ENV: "production" },
  });

  if (print) {
    process.stdout.write(plist);
    process.stderr.write(`\n# would be written to ${plistPath}\n`);
    return;
  }

  if (process.platform !== "darwin") {
    process.stderr.write(
      `install-daemon writes a launchd agent, which is macOS-only (this is ${process.platform}).\n` +
        `Use --print to preview the plist; the Linux equivalent is a systemd unit ` +
        `with Restart=always (DECISIONS.md).\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (!existsSync(entryPath)) {
    process.stderr.write(
      `warning: ${entryPath} does not exist yet — run \`pnpm build\` before \`launchctl load\`.\n`,
    );
  }

  mkdirSync(logDir, { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist);

  process.stdout.write(
    [
      `Wrote ${plistPath}`,
      ``,
      `Next:`,
      `  pnpm build                          # produce ${entryPath}`,
      `  launchctl load -w ${plistPath}`,
      ``,
      `Check:   launchctl list | grep ${LABEL}`,
      `Logs:    tail -f ${join(logDir, "daemon.out.log")}`,
      `Remove:  launchctl unload -w ${plistPath} && rm ${plistPath}`,
      ``,
    ].join("\n"),
  );
}

main();
