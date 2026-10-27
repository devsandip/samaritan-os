/**
 * One daemon per Action Store.
 *
 * Boot reconciliation assumes it is alone: it fences every `running` run, fails
 * pending execution rows and re-drives approved items. A second `pnpm serve`
 * beside the launchd daemon would do all of that to the live daemon's work
 * before it even found the port busy. So the daemon takes this lock first, and
 * a second one stops with a clear message instead.
 *
 * The lock is a file created exclusively next to the database, holding the
 * owner's pid. A file left by a process that no longer exists is stale and is
 * taken over.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export class InstanceLockedError extends Error {
  constructor(readonly pid: number, path: string) {
    super(`another Samaritan daemon (pid ${pid}) is already using this database (${path})`);
    this.name = "InstanceLockedError";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else: still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the lock for `dbPath`, or throws. Returns the release function. */
export function acquireInstanceLock(dbPath: string): () => void {
  if (dbPath === ":memory:") return () => undefined;
  const path = `${dbPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
        } catch {
          // Already gone.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && alive(owner)) {
        throw new InstanceLockedError(owner, path);
      }
      unlinkSync(path); // stale: its owner is gone
    }
  }
  throw new Error(`could not take the daemon lock at ${path}`);
}
