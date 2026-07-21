import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PublishResult } from "../src/events/index.js";
import { VaultWatcher } from "../src/events/listeners/vault-watch.js";
import type { SamaritanEvent } from "../src/events/types.js";

/**
 * The unit-level decision is covered exhaustively in file-event.test.ts; this
 * proves the wiring the pure function cannot — that a real write, through real
 * chokidar, reaches publish — because "only contact with the real system catches
 * integration errors" is a lesson this project keeps relearning.
 */
function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for event"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("VaultWatcher", () => {
  let dir: string;
  let watcher: VaultWatcher | undefined;
  let published: SamaritanEvent[];

  const publish = async (event: SamaritanEvent): Promise<PublishResult> => {
    published.push(event);
    return { event_id: event.id, type: event.type, deduped: false, dispatched: [], matched: [] };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sam-vault-"));
    published = [];
  });

  afterEach(async () => {
    await watcher?.stop();
    watcher = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes note.created when a markdown note is written to the vault", async () => {
    watcher = new VaultWatcher({
      roots: [{ dir, kind: "note", source: "vault" }],
      publish,
      settleMs: 20,
    });
    await watcher.start();

    mkdirSync(join(dir, "Inbox"));
    writeFileSync(join(dir, "Inbox", "idea.md"), "# An idea\n");

    await waitFor(() => published.length >= 1);
    expect(published[0]).toMatchObject({
      type: "note.created",
      source: "vault",
      payload: { path: "Inbox/idea.md", title: "idea", folder: "Inbox", kind: "note" },
    });
    expect(published[0]?.id).toContain("idea.md@");
  });

  it("does not publish for a non-markdown file", async () => {
    watcher = new VaultWatcher({ roots: [{ dir, kind: "note" }], publish, settleMs: 20 });
    await watcher.start();

    // Write the attachment first, then a real note. When the note arrives we know
    // the watch has processed both, so the attachment's absence is conclusive.
    writeFileSync(join(dir, "photo.png"), "not markdown");
    writeFileSync(join(dir, "real.md"), "# Real\n");

    await waitFor(() => published.some((e) => e.payload["path"] === "real.md"));
    expect(published.some((e) => String(e.payload["path"]).endsWith(".png"))).toBe(false);
  });

  it("does not publish for a hidden .obsidian write, even a markdown one", async () => {
    watcher = new VaultWatcher({ roots: [{ dir, kind: "note" }], publish, settleMs: 20 });
    await watcher.start();

    mkdirSync(join(dir, ".obsidian"));
    writeFileSync(join(dir, ".obsidian", "hidden.md"), "config");
    writeFileSync(join(dir, "visible.md"), "# Visible\n");

    await waitFor(() => published.some((e) => e.payload["path"] === "visible.md"));
    expect(published.some((e) => String(e.payload["path"]).includes(".obsidian"))).toBe(false);
  });

  it("is an idle no-op when the vault root does not exist", async () => {
    watcher = new VaultWatcher({
      roots: [{ dir: join(dir, "nope"), kind: "note" }],
      publish,
      settleMs: 20,
    });
    // Must resolve rather than throw, and nothing is published.
    await expect(watcher.start()).resolves.toBeUndefined();
    expect(published).toEqual([]);
  });
});
