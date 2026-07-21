import { describe, expect, it } from "vitest";
import { StoreCheckpoint } from "../src/store/poll-state.js";
import { openDatabase, type Db } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";

function freshDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

describe("StoreCheckpoint", () => {
  it("loads 0 before anything is saved", () => {
    const cp = new StoreCheckpoint(freshDb(), "gmail");
    expect(cp.load()).toBe(0);
  });

  it("round-trips a saved mark", () => {
    const cp = new StoreCheckpoint(freshDb(), "gmail");
    cp.save(1753000000000);
    expect(cp.load()).toBe(1753000000000);
  });

  it("upserts the mark rather than inserting a second row", () => {
    const db = freshDb();
    const cp = new StoreCheckpoint(db, "gmail");
    cp.save(100);
    cp.save(200);
    expect(cp.load()).toBe(200);
    const count = db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM poll_state WHERE listener = ?")
      .get("gmail");
    expect(count?.n).toBe(1);
  });

  it("keeps separate listeners' cursors apart", () => {
    const db = freshDb();
    new StoreCheckpoint(db, "gmail").save(100);
    new StoreCheckpoint(db, "fireflies").save(999);
    expect(new StoreCheckpoint(db, "gmail").load()).toBe(100);
    expect(new StoreCheckpoint(db, "fireflies").load()).toBe(999);
  });
});
