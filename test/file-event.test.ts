import { describe, expect, it } from "vitest";
import { fileChangeToEvent, type WatchRoot } from "../src/events/listeners/file-event.js";

const VAULT: WatchRoot = { dir: "/vault", kind: "note", source: "vault" };
// mtime with a fractional millisecond, so the flooring is visible in the id.
const MTIME = 1_700_000_000_123.7;

describe("fileChangeToEvent", () => {
  it("turns a new markdown file into a <kind>.created event", () => {
    const event = fileChangeToEvent({ event: "add", path: "/vault/Inbox/idea.md", mtimeMs: MTIME }, VAULT);
    expect(event).toEqual({
      type: "note.created",
      id: "file:/vault/Inbox/idea.md@1700000000123",
      payload: { path: "Inbox/idea.md", title: "idea", folder: "Inbox", kind: "note" },
      occurred_at: new Date(1_700_000_000_123).toISOString(),
      source: "vault",
    });
  });

  it("turns a changed file into a <kind>.updated event", () => {
    const event = fileChangeToEvent({ event: "change", path: "/vault/Inbox/idea.md", mtimeMs: MTIME }, VAULT);
    expect(event?.type).toBe("note.updated");
  });

  it("uses the root's kind, so a journal root yields journal.updated", () => {
    const journal: WatchRoot = { dir: "/dev/journal", kind: "journal" };
    const created = fileChangeToEvent({ event: "add", path: "/dev/journal/2026-07-21.md", mtimeMs: MTIME }, journal);
    const updated = fileChangeToEvent({ event: "change", path: "/dev/journal/2026-07-21.md", mtimeMs: MTIME }, journal);
    expect(created?.type).toBe("journal.created");
    expect(updated?.type).toBe("journal.updated");
    // No source given on the root, so it defaults.
    expect(created?.source).toBe("filesystem");
  });

  it("reports the folder as empty for a file at the vault root", () => {
    const event = fileChangeToEvent({ event: "add", path: "/vault/README.md", mtimeMs: MTIME }, VAULT);
    expect(event?.payload).toMatchObject({ path: "README.md", title: "README", folder: "" });
  });

  it("carries the nested folder path so a filter can select a subtree", () => {
    const event = fileChangeToEvent(
      { event: "add", path: "/vault/Areas/Weekly/2026-W29.md", mtimeMs: MTIME },
      VAULT,
    );
    expect(event?.payload).toMatchObject({ folder: "Areas/Weekly", title: "2026-W29" });
  });

  it("ignores anything that is not markdown", () => {
    for (const path of ["/vault/attachments/pic.png", "/vault/notes.txt", "/vault/Inbox/noext"]) {
      expect(fileChangeToEvent({ event: "add", path, mtimeMs: MTIME }, VAULT)).toBeNull();
    }
  });

  it("ignores hidden paths — the Obsidian config, the trash, a git dir", () => {
    for (const path of [
      "/vault/.obsidian/workspace.md",
      "/vault/.trash/deleted.md",
      "/vault/.git/COMMIT_EDITMSG.md",
    ]) {
      expect(fileChangeToEvent({ event: "add", path, mtimeMs: MTIME }, VAULT)).toBeNull();
    }
  });

  it("ignores a path that resolves outside the watched root", () => {
    expect(fileChangeToEvent({ event: "add", path: "/elsewhere/note.md", mtimeMs: MTIME }, VAULT)).toBeNull();
    // The root directory itself is not a note.
    expect(fileChangeToEvent({ event: "add", path: "/vault", mtimeMs: MTIME }, VAULT)).toBeNull();
  });

  it("matches .md case-insensitively but strips only the extension from the title", () => {
    const event = fileChangeToEvent({ event: "add", path: "/vault/Notes/Plan.MD", mtimeMs: MTIME }, VAULT);
    expect(event?.type).toBe("note.created");
    expect(event?.payload).toMatchObject({ title: "Plan" });
  });
});
