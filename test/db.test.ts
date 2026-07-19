import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/db.js";

function seeded() {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE t(a INTEGER PRIMARY KEY)");
  return db;
}

const rows = (db: ReturnType<typeof seeded>) =>
  db.prepare<{ a: number }>("SELECT a FROM t ORDER BY a").all().map((r) => r.a);

describe("openDatabase", () => {
  it("commits work done inside a transaction", () => {
    const db = seeded();
    db.transaction(() => {
      db.prepare("INSERT INTO t VALUES (?)").run(1);
      db.prepare("INSERT INTO t VALUES (?)").run(2);
    });
    expect(rows(db)).toEqual([1, 2]);
  });

  it("rolls the whole transaction back when the body throws", () => {
    const db = seeded();
    db.prepare("INSERT INTO t VALUES (?)").run(1);

    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES (?)").run(2);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(rows(db)).toEqual([1]);
  });

  it("returns the body's value", () => {
    const db = seeded();
    expect(db.transaction(() => 42)).toBe(42);
  });

  it("undoes only the inner scope when a nested transaction fails and is caught", () => {
    const db = seeded();
    db.transaction(() => {
      db.prepare("INSERT INTO t VALUES (?)").run(1);
      try {
        db.transaction(() => {
          db.prepare("INSERT INTO t VALUES (?)").run(2);
          throw new Error("inner");
        });
      } catch {
        // swallowed on purpose — the outer transaction should still commit
      }
      db.prepare("INSERT INTO t VALUES (?)").run(3);
    });

    expect(rows(db)).toEqual([1, 3]);
  });

  it("rolls the outer scope back when a nested failure propagates", () => {
    const db = seeded();
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES (?)").run(1);
        db.transaction(() => {
          db.prepare("INSERT INTO t VALUES (?)").run(2);
          throw new Error("inner");
        });
      }),
    ).toThrow("inner");

    expect(rows(db)).toEqual([]);
  });

  it("stays usable after a rollback", () => {
    const db = seeded();
    try {
      db.transaction(() => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    db.transaction(() => db.prepare("INSERT INTO t VALUES (?)").run(9));
    expect(rows(db)).toEqual([9]);
  });

  it("enforces foreign keys", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE parent(id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))");
    expect(() => db.prepare("INSERT INTO child VALUES (?, ?)").run("c1", "missing")).toThrow();
  });
});
