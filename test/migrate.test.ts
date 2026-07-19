import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/db.js";
import { currentVersion, migrate } from "../src/store/migrate.js";
import { MIGRATIONS } from "../src/store/migrations.js";

function migrated() {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

const tableNames = (db: ReturnType<typeof migrated>) =>
  db
    .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);

describe("migrate", () => {
  it("applies every migration on a fresh database", () => {
    const db = openDatabase(":memory:");
    expect(currentVersion(db)).toBe(0);

    const result = migrate(db);
    expect(result.applied).toHaveLength(MIGRATIONS.length);
    expect(currentVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
  });

  it("is idempotent", () => {
    const db = migrated();
    const second = migrate(db);
    expect(second.applied).toHaveLength(0);
  });

  it("creates every table §4.4 specifies", () => {
    const names = tableNames(migrated());
    for (const expected of [
      "action_item_events",
      "action_items",
      "calendar_events",
      "capabilities",
      "connections",
      "executions",
      "notion_decisions",
      "notion_insights",
      "recall_chunks",
      "routing_config",
      "ticktick_tasks",
      "triggers",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("creates the FTS5 index for recall", () => {
    const db = migrated();
    db.exec(
      "INSERT INTO recall_chunks (source_kind, source_path, chunk_text, updated_at) " +
        "VALUES ('obsidian', 'Notes/a.md', 'vendor pricing volatility', '2026-07-19T00:00:00Z')",
    );
    db.exec("INSERT INTO recall_chunks_fts(recall_chunks_fts) VALUES('rebuild')");
    const hits = db
      .prepare<{ source_path: string }>(
        "SELECT source_path FROM recall_chunks_fts WHERE recall_chunks_fts MATCH ?",
      )
      .all("volatility");
    expect(hits.map((h) => h.source_path)).toEqual(["Notes/a.md"]);
  });

  it("rolls back a failing migration rather than half-applying it", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      migrate(db, [
        { version: 1, name: "ok", sql: "CREATE TABLE a(x)" },
        // The second statement fails, after the first has already run. Only the
        // surrounding transaction can undo the partial work.
        { version: 2, name: "broken", sql: "CREATE TABLE b(x); CREATE TABLE b(x);" },
      ]),
    ).toThrow();

    expect(currentVersion(db)).toBe(1);
    const names = tableNames(db);
    expect(names).toContain("a");
    expect(names).not.toContain("b");
  });
});

describe("action_item_events append-only enforcement (§9)", () => {
  function withEvent() {
    const db = migrated();
    db.exec(`
      INSERT INTO capabilities (id, name, version, manifest_json, registered_at)
      VALUES ('cap', 'Cap', '0.1.0', '{}', '2026-07-19T00:00:00Z');
      INSERT INTO action_items
        (id, capability_id, type, status, dedupe_key, context_json, custom_json,
         responses_json, execution_json, created_at, updated_at)
      VALUES ('item-1', 'cap', 't', 'pending', 'k1', '{}', '{}', '[]', '{}',
              '2026-07-19T00:00:00Z', '2026-07-19T00:00:00Z');
      INSERT INTO action_item_events
        (id, action_item_id, from_status, to_status, actor, created_at)
      VALUES ('ev-1', 'item-1', NULL, 'pending', 'capability', '2026-07-19T00:00:00Z');
    `);
    return db;
  }

  it("rejects UPDATE on the audit trail", () => {
    const db = withEvent();
    expect(() => db.exec("UPDATE action_item_events SET actor='sandip' WHERE id='ev-1'")).toThrow(
      /append-only/,
    );
  });

  it("rejects DELETE on the audit trail", () => {
    const db = withEvent();
    expect(() => db.exec("DELETE FROM action_item_events WHERE id='ev-1'")).toThrow(/append-only/);
    expect(
      db.prepare<{ n: number }>("SELECT COUNT(*) n FROM action_item_events").get()?.n,
    ).toBe(1);
  });

  it("still allows INSERT", () => {
    const db = withEvent();
    db.exec(
      "INSERT INTO action_item_events (id, action_item_id, from_status, to_status, actor, created_at) " +
        "VALUES ('ev-2', 'item-1', 'pending', 'approved', 'sandip', '2026-07-19T00:01:00Z')",
    );
    expect(
      db.prepare<{ n: number }>("SELECT COUNT(*) n FROM action_item_events").get()?.n,
    ).toBe(2);
  });
});

describe("action_items constraints", () => {
  it("rejects a duplicate (capability_id, dedupe_key)", () => {
    const db = migrated();
    db.exec(`
      INSERT INTO capabilities (id, name, version, manifest_json, registered_at)
      VALUES ('cap', 'Cap', '0.1.0', '{}', '2026-07-19T00:00:00Z');
      INSERT INTO action_items
        (id, capability_id, type, status, dedupe_key, context_json, custom_json,
         responses_json, execution_json, created_at, updated_at)
      VALUES ('i1', 'cap', 't', 'pending', 'same', '{}', '{}', '[]', '{}', 'now', 'now');
    `);
    expect(() =>
      db.exec(`
        INSERT INTO action_items
          (id, capability_id, type, status, dedupe_key, context_json, custom_json,
           responses_json, execution_json, created_at, updated_at)
        VALUES ('i2', 'cap', 't', 'pending', 'same', '{}', '{}', '[]', '{}', 'now', 'now');
      `),
    ).toThrow(/UNIQUE/i);
  });

  it("rejects an action item referencing an unknown capability", () => {
    const db = migrated();
    expect(() =>
      db.exec(`
        INSERT INTO action_items
          (id, capability_id, type, status, dedupe_key, context_json, custom_json,
           responses_json, execution_json, created_at, updated_at)
        VALUES ('i1', 'ghost', 't', 'pending', 'k', '{}', '{}', '[]', '{}', 'now', 'now');
      `),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("executions constraints", () => {
  it("rejects a duplicate (idempotency_key, attempt)", () => {
    const db = migrated();
    db.exec(`
      INSERT INTO capabilities (id, name, version, manifest_json, registered_at)
      VALUES ('cap', 'Cap', '0.1.0', '{}', 'now');
      INSERT INTO action_items
        (id, capability_id, type, status, dedupe_key, context_json, custom_json,
         responses_json, execution_json, created_at, updated_at)
      VALUES ('i1', 'cap', 't', 'approved', 'k', '{}', '{}', '[]', '{}', 'now', 'now');
      INSERT INTO executions (id, action_item_id, mode, capability, idempotency_key, attempt, status, started_at)
      VALUES ('e1', 'i1', 'automated', 'notion.insight.create', 'idem-1', 1, 'pending', 'now');
    `);
    expect(() =>
      db.exec(
        "INSERT INTO executions (id, action_item_id, mode, capability, idempotency_key, attempt, status, started_at) " +
          "VALUES ('e2', 'i1', 'automated', 'notion.insight.create', 'idem-1', 1, 'pending', 'now')",
      ),
    ).toThrow(/UNIQUE/i);
  });

  it("allows a retry as a new attempt under the same idempotency key", () => {
    const db = migrated();
    db.exec(`
      INSERT INTO capabilities (id, name, version, manifest_json, registered_at)
      VALUES ('cap', 'Cap', '0.1.0', '{}', 'now');
      INSERT INTO action_items
        (id, capability_id, type, status, dedupe_key, context_json, custom_json,
         responses_json, execution_json, created_at, updated_at)
      VALUES ('i1', 'cap', 't', 'approved', 'k', '{}', '{}', '[]', '{}', 'now', 'now');
      INSERT INTO executions (id, action_item_id, mode, capability, idempotency_key, attempt, status, started_at)
      VALUES ('e1', 'i1', 'automated', 'notion.insight.create', 'idem-1', 1, 'failed', 'now');
      INSERT INTO executions (id, action_item_id, mode, capability, idempotency_key, attempt, status, started_at)
      VALUES ('e2', 'i1', 'automated', 'notion.insight.create', 'idem-1', 2, 'succeeded', 'now');
    `);
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) n FROM executions").get()?.n).toBe(2);
  });
});
