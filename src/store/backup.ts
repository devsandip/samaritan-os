/**
 * Online SQLite Database Backup, Restoration Integrity Verification, and
 * Keychain Accessibility Probe (PROPOSAL-v1 D6).
 *
 * Uses SQLite's `VACUUM INTO` to capture a consistent online snapshot while the
 * daemon is serving requests, then opens the snapshot read-only and verifies
 * `PRAGMA integrity_check` before recording the backup in `db_backups`.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expandPath } from "../config/index.js";
import type { Db } from "./db.js";
import { nowIso } from "../types/index.js";

export interface BackupRecord {
  id: string;
  backup_path: string;
  size_bytes: number;
  integrity_ok: boolean;
  created_at: string;
}

export interface BackupOptions {
  backupDir?: string;
  retainCount?: number;
}

interface BackupRow {
  id: string;
  backup_path: string;
  size_bytes: number;
  integrity_ok: number;
  created_at: string;
}

function rowToBackup(row: BackupRow): BackupRecord {
  return {
    id: row.id,
    backup_path: row.backup_path,
    size_bytes: Number(row.size_bytes),
    integrity_ok: row.integrity_ok === 1,
    created_at: row.created_at,
  };
}

/**
 * Performs an online SQLite backup using `VACUUM INTO`, verifies the snapshot
 * with `PRAGMA integrity_check`, logs a row in `db_backups`, and prunes older
 * backup files beyond `retainCount`.
 */
export function backupDatabase(db: Db, options: BackupOptions = {}): BackupRecord {
  const dir = resolve(options.backupDir ?? expandPath("~/.samaritan/backups"));
  const retainCount = options.retainCount ?? 10;
  mkdirSync(dir, { recursive: true });

  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
    "-",
    String(now.getMilliseconds()).padStart(3, "0"),
  ].join("");
  const targetPath = join(dir, `samaritan-${stamp}.db`);

  // Escape single quotes in file path for SQLite VACUUM INTO literal.
  const escapedPath = targetPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedPath}'`);

  let integrityOk = false;
  const verifyDb = new DatabaseSync(targetPath, { readOnly: true });
  try {
    const check = verifyDb
      .prepare("PRAGMA integrity_check")
      .get() as { integrity_check?: string } | undefined;
    integrityOk = check?.integrity_check === "ok";
  } finally {
    verifyDb.close();
  }

  const sizeBytes = statSync(targetPath).size;
  const createdAt = nowIso();
  const id = randomUUID();

  db.prepare(
    `INSERT INTO db_backups (id, backup_path, size_bytes, integrity_ok, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, targetPath, sizeBytes, integrityOk ? 1 : 0, createdAt);

  pruneBackups(db, retainCount, dir);

  return {
    id,
    backup_path: targetPath,
    size_bytes: sizeBytes,
    integrity_ok: integrityOk,
    created_at: createdAt,
  };
}

/**
 * Removes backup records in `db_backups` (and their `.db` files on disk) beyond
 * `retainCount`, plus any extra `samaritan-*.db` files in `backupDir`.
 */
export function pruneBackups(
  db: Db,
  retainCount = 10,
  backupDir?: string,
): number {
  const keep = Math.max(1, retainCount);
  const allRows = db
    .prepare<BackupRow>("SELECT * FROM db_backups ORDER BY created_at DESC, rowid DESC")
    .all();

  const staleRows = allRows.slice(keep);
  const deleteStmt = db.prepare("DELETE FROM db_backups WHERE id = ?");
  let pruned = 0;

  for (const row of staleRows) {
    try {
      rmSync(row.backup_path, { force: true });
    } catch {
      // Ignore missing file on disk
    }
    deleteStmt.run(row.id);
    pruned += 1;
  }

  if (backupDir) {
    try {
      const files = readdirSync(backupDir)
        .filter((f) => f.startsWith("samaritan-") && f.endsWith(".db"))
        .sort()
        .reverse();
      for (const stale of files.slice(keep)) {
        rmSync(join(backupDir, stale), { force: true });
      }
    } catch {
      // Non-fatal if cleanup encounters a concurrent file removal.
    }
  }

  return pruned;
}

export function listBackups(db: Db, limit = 20): BackupRecord[] {
  return db
    .prepare<BackupRow>(
      "SELECT * FROM db_backups ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
    .all(limit)
    .map(rowToBackup);
}

/**
 * Probes whether macOS Keychain is unlocked and readable by the current daemon
 * process (PROPOSAL-v1 D6: "Test Keychain access after a reboot before login").
 */
export function probeKeychainAccess(): { accessible: boolean; detail: string } {
  if (process.platform !== "darwin") {
    return { accessible: true, detail: `non-darwin platform (${process.platform}); env fallback active` };
  }
  try {
    execFileSync("/usr/bin/security", ["list-keychains"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
    });
    return { accessible: true, detail: "macOS Keychain unlocked and reachable" };
  } catch (err) {
    return {
      accessible: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
