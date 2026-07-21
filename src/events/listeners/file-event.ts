/**
 * The pure core of the filesystem listener (TECH-SPEC §2.2, §12 step 18).
 *
 * The chokidar watch in `vault-watch.ts` is a thin shell around this one
 * function: it turns a raw filesystem change — a path and its mtime — into a
 * `SamaritanEvent`, or decides the change is not one worth publishing. Keeping
 * that judgement here, as a pure function of its inputs, is the same move the
 * Scheduler made with its cron matcher: the part with the decision in it is
 * testable without a real clock or, here, a real disk.
 *
 * The source id is `file:<absolute path>@<mtime>` — the path is the file's
 * identity and the mtime is its version — which is exactly the "file path +
 * mtime" §2.2 names as the dedup key. So the same write seen twice (a doubled
 * chokidar event, or a future nightly reconcile re-reading a file the watch
 * already reported) fires a capability once, the same claim-before-dispatch the
 * Event Bus already does on `id`.
 */
import { basename, dirname, relative } from "node:path";
import type { SamaritanEvent } from "../types.js";

/** A raw filesystem change, as chokidar reports it (an `add` or `change` + stat). */
export interface FileChange {
  /** chokidar's event name. `add` becomes `<kind>.created`, `change` `<kind>.updated`. */
  event: "add" | "change";
  /** Absolute path to the file. */
  path: string;
  /** File mtime in epoch milliseconds — the version half of the source id. */
  mtimeMs: number;
}

/** One watched location and the event namespace its changes publish under. */
export interface WatchRoot {
  /** Absolute directory watched. */
  dir: string;
  /** Event namespace: `note` yields note.created/note.updated, `journal` journal.*. */
  kind: string;
  /** `source` stamped on the event; informational. Defaults to `filesystem`. */
  source?: string;
}

const MARKDOWN = /\.md$/i;

/** True when a path has a hidden segment (`.obsidian`, `.git`, `.trash`) below the root. */
function hasHiddenSegment(relPath: string): boolean {
  return relPath.split("/").some((seg) => seg.length > 1 && seg.startsWith("."));
}

/**
 * Maps a filesystem change to the event it should publish, or `null` when the
 * change is not one: a non-markdown file (an attachment, a `.obsidian` json), a
 * hidden path, or a file that resolves outside the root. Returning `null` rather
 * than throwing keeps the caller a straight `if (event) publish(event)`.
 *
 * `occurred_at` is the file's own mtime, not receipt time — the truthful answer
 * to "when did this happen?" is when the note was written — which also keeps the
 * function pure: same inputs, same event, no wall clock.
 */
export function fileChangeToEvent(change: FileChange, root: WatchRoot): SamaritanEvent | null {
  if (!MARKDOWN.test(change.path)) return null;

  const rel = relative(root.dir, change.path).replace(/\\/g, "/");
  // `relative` climbs out with `..` when the path is not under the root, and is
  // empty when the path *is* the root — neither is a note event.
  if (rel === "" || rel === ".." || rel.startsWith("../")) return null;
  if (hasHiddenSegment(rel)) return null;

  const folder = dirname(rel);
  const mtime = Math.floor(change.mtimeMs);

  return {
    type: `${root.kind}.${change.event === "add" ? "created" : "updated"}`,
    id: `file:${change.path}@${mtime}`,
    payload: {
      path: rel,
      title: basename(rel).replace(MARKDOWN, ""),
      folder: folder === "." ? "" : folder,
      kind: root.kind,
    },
    occurred_at: new Date(mtime).toISOString(),
    source: root.source ?? "filesystem",
  };
}
