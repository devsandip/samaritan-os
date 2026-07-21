/**
 * The launchd agent that keeps the daemon alive (TECH-SPEC §6, §12 step 16).
 *
 * Pure by design, like the cron matcher and the file→event mapper: rendering the
 * plist is a decision about text (what keys, in what order, escaped how) with no
 * disk in it, so it lives here and is tested without touching `~/Library`. The
 * `install-daemon` CLI is the thin shell that resolves real paths and writes the
 * result. `RunAtLoad` + `KeepAlive` are the two keys that make this supervision
 * rather than a launcher: the first starts the daemon at login, the second
 * restarts it if it exits — which is exactly the restart the §11 boot
 * reconciliation is there to recover from cleanly.
 */
export interface PlistOptions {
  /** Reverse-DNS agent id, e.g. `com.sandipdev.samaritan`. */
  label: string;
  /** The `node` binary that runs the daemon. */
  nodePath: string;
  /** The daemon entry it runs, e.g. `<repo>/dist/cli/serve.js`. */
  entryPath: string;
  /** cwd for the process, so relative reads (capabilities/, ui/dist) resolve. */
  workingDir: string;
  outLog: string;
  errLog: string;
  /**
   * Environment for the supervised process. Rendered in insertion order, so the
   * output is deterministic. `SAMARITAN_CONFIG` belongs here: a login agent does
   * not inherit a shell's exports, so the daemon would otherwise never find a
   * non-default config.
   */
  env: Record<string, string>;
}

const DOCTYPE =
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
  '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">';

/** Escapes the five predefined XML entities. Paths rarely contain them, but a
 *  home directory or config path with an `&` would otherwise emit invalid XML. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderPlist(o: PlistOptions): string {
  const env = Object.entries(o.env)
    .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
${DOCTYPE}
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(o.nodePath)}</string>
    <string>${esc(o.entryPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(o.workingDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(o.outLog)}</string>
  <key>StandardErrorPath</key><string>${esc(o.errLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
</dict>
</plist>
`;
}
