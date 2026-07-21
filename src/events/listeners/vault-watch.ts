/**
 * The filesystem listener (TECH-SPEC §2.2 "Event Bus & listeners", §12 step 18).
 *
 * A chokidar watch over the Obsidian vault. The Event Bus's other front ends are
 * a Gmail poller and a Fireflies webhook — network and credentials — and this is
 * the one that needs neither: a note written to the vault becomes a
 * `note.created` / `note.updated` event on the same bus, so a capability fires
 * because a file appeared, not because someone typed a curl into `POST /events`.
 *
 * The class owns nothing but the watcher. What a change *means* is
 * `fileChangeToEvent`; what to *do* with the resulting event is `publish` (the
 * Event Bus). This only turns chokidar's callbacks into `publish` calls,
 * isolates their failures, and starts and stops alongside the API server the way
 * the Scheduler does — the daemon-only, long-lived half §2.2 keeps out of the bus
 * itself.
 */
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { log } from "../../logger.js";
import type { PublishResult } from "../index.js";
import type { SamaritanEvent } from "../types.js";
import { fileChangeToEvent, type WatchRoot } from "./file-event.js";

const logger = log("vault-watch");

/** §2.2: wait for a chunked write to settle before reading, so no partial note fires. */
const DEFAULT_SETTLE_MS = 300;

export interface VaultWatcherDeps {
  /** Locations to watch. A root whose directory is missing is skipped, not fatal. */
  roots: WatchRoot[];
  /** The Event Bus's `publish`. Injected so the watcher can be tested against a spy. */
  publish: (event: SamaritanEvent) => Promise<PublishResult>;
  /**
   * `awaitWriteFinish` stability window. Defaults to 300ms (§2.2); a test lowers
   * it so it need not wait a third of a second per write, the same seam the
   * Scheduler's `intervalMs` is.
   */
  settleMs?: number;
}

export class VaultWatcher {
  readonly #roots: WatchRoot[];
  readonly #publish: VaultWatcherDeps["publish"];
  readonly #settleMs: number;
  #watcher: FSWatcher | undefined;

  constructor(deps: VaultWatcherDeps) {
    // Longest directory first, so a nested root wins the prefix match over its parent.
    this.#roots = [...deps.roots].sort((a, b) => b.dir.length - a.dir.length);
    this.#publish = deps.publish;
    this.#settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  }

  /**
   * Begins watching. A root whose directory does not exist is logged and skipped
   * — a vault not yet created must not stop the daemon from starting — and if
   * none remain the watcher is an idle no-op. Resolves once chokidar's initial
   * scan is done, so the caller (and a test) knows the watch is live before the
   * first write.
   */
  async start(): Promise<void> {
    const present = this.#roots.filter((r) => {
      if (existsSync(r.dir)) return true;
      logger.warn({ dir: r.dir, kind: r.kind }, "watch root does not exist, skipping");
      return false;
    });
    if (present.length === 0) {
      logger.info("no watch roots present; filesystem listener idle");
      return;
    }

    const watcher = watch(
      present.map((r) => r.dir),
      {
        // The vault already holds thousands of notes; publishing note.created for
        // each on boot would flood the bus. The listener reacts to *changes* — the
        // backlog is the "nightly full reconcile" §2.2 names, a separate path.
        ignoreInitial: true,
        persistent: true,
        // mtime is half the dedup id, so it must accompany every event.
        alwaysStat: true,
        awaitWriteFinish: { stabilityThreshold: this.#settleMs, pollInterval: Math.min(100, this.#settleMs) },
        // Skip hidden trees (.obsidian, .git, .trash). The markdown-vs-attachment
        // decision stays in fileChangeToEvent, the one place that owns it.
        ignored: (path) => this.#isHidden(path),
      },
    );

    watcher.on("add", (path, stats) => this.#onChange("add", path, stats?.mtimeMs));
    watcher.on("change", (path, stats) => this.#onChange("change", path, stats?.mtimeMs));
    watcher.on("error", (err) => logger.error({ err: String(err) }, "watch error"));

    await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
    this.#watcher = watcher;
    logger.info({ roots: present.map((r) => r.dir) }, "watching vault");
  }

  async stop(): Promise<void> {
    await this.#watcher?.close();
    this.#watcher = undefined;
  }

  /** The root a path belongs to — the longest configured dir that is its prefix. */
  #rootOf(path: string): WatchRoot | undefined {
    return this.#roots.find((r) => path === r.dir || path.startsWith(r.dir + sep));
  }

  /** True when a path has a hidden segment *below* its root, so a dotted root is fine. */
  #isHidden(path: string): boolean {
    const root = this.#rootOf(path);
    const rel = root ? path.slice(root.dir.length) : path;
    return rel.split(sep).some((seg) => seg.length > 1 && seg.startsWith("."));
  }

  /**
   * A chokidar callback becomes an event. A missing stat (no mtime) is skipped —
   * the id depends on it — and a `publish` that rejects is logged, never thrown,
   * so one bad write cannot kill the watch, the same isolation the bus gives one
   * failing subscriber.
   */
  #onChange(event: "add" | "change", path: string, mtimeMs: number | undefined): void {
    if (mtimeMs === undefined) return;
    const root = this.#rootOf(path);
    if (!root) return;

    const samEvent = fileChangeToEvent({ event, path, mtimeMs }, root);
    if (!samEvent) return;

    void this.#publish(samEvent).catch((err) =>
      logger.error({ path, err: String(err) }, "publish from watch failed"),
    );
  }
}
