/**
 * One daemon per Action Store: a second one must stop before its boot
 * reconciliation touches the first one's work.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireInstanceLock, InstanceLockedError } from "../src/store/instance-lock.js";

let dir: string;
let db: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "samaritan-lock-"));
  db = join(dir, "samaritan.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("acquireInstanceLock", () => {
  it("refuses while another live process holds the lock", () => {
    writeFileSync(`${db}.lock`, String(process.ppid)); // the test runner's parent is alive
    expect(() => acquireInstanceLock(db)).toThrow(InstanceLockedError);
  });

  it("takes over a lock whose owner is gone, and releases it", () => {
    writeFileSync(`${db}.lock`, "999999");
    const release = acquireInstanceLock(db);
    expect(readFileSync(`${db}.lock`, "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(`${db}.lock`)).toBe(false);
  });

  it("needs no lock for an in-memory store", () => {
    expect(() => acquireInstanceLock(":memory:")()).not.toThrow();
  });
});
