import { describe, expect, it } from "vitest";
import { EventBus } from "../src/events/index.js";
import type { SamaritanEvent } from "../src/events/types.js";
import type { CapabilityRegistry } from "../src/registry/index.js";
import { openDatabase, type Db } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";
import { harness } from "./helpers.js";

function freshDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

/** A stand-in registry whose `all()` returns exactly the capabilities a test declares. */
function fakeRegistry(
  caps: {
    id: string;
    enabled?: boolean;
    mode?: string;
    on?: string[];
    filter?: Record<string, unknown>;
  }[],
): CapabilityRegistry {
  return {
    all: () =>
      caps.map((c) => ({
        manifest: {
          id: c.id,
          enabled: c.enabled !== false,
          trigger: {
            mode: c.mode ?? "event",
            ...(c.on ? { on: c.on } : {}),
            ...(c.filter ? { filter: c.filter } : {}),
          },
        },
      })),
  } as unknown as CapabilityRegistry;
}

function emailEvent(overrides: Partial<SamaritanEvent> = {}): SamaritanEvent {
  return {
    type: "email.received",
    id: "gmail:1",
    payload: { id: "1", from: "boss@work.com", subject: "hi", body: "..." },
    ...overrides,
  };
}

function busWith(db: Db, registry: CapabilityRegistry, fired: string[]): EventBus {
  return new EventBus({
    db,
    capabilities: registry,
    fire: async (capabilityId) => void fired.push(capabilityId),
  });
}

describe("EventBus dispatch", () => {
  it("fires every enabled subscriber to the event type", async () => {
    const db = freshDb();
    const registry = fakeRegistry([
      { id: "a", on: ["email.received"] },
      { id: "b", on: ["email.received"] },
      { id: "c", on: ["slack.message"] }, // different type
    ]);
    const fired: string[] = [];

    const result = await busWith(db, registry, fired).publish(emailEvent());

    expect(fired.sort()).toEqual(["a", "b"]);
    expect(result).toMatchObject({ deduped: false, dispatched: ["a", "b"] });
  });

  it("skips a disabled subscriber", async () => {
    const db = freshDb();
    const registry = fakeRegistry([
      { id: "on", on: ["email.received"] },
      { id: "off", on: ["email.received"], enabled: false },
    ]);
    const fired: string[] = [];

    await busWith(db, registry, fired).publish(emailEvent());

    expect(fired).toEqual(["on"]);
  });

  it("skips a scheduled-mode capability even if it lists the type", async () => {
    const db = freshDb();
    const registry = fakeRegistry([{ id: "cron", mode: "scheduled", on: ["email.received"] }]);
    const fired: string[] = [];

    await busWith(db, registry, fired).publish(emailEvent());

    expect(fired).toEqual([]);
  });

  it("applies the subscriber's filter", async () => {
    const db = freshDb();
    const registry = fakeRegistry([
      { id: "all-mail", on: ["email.received"] },
      { id: "newsletters", on: ["email.received"], filter: { from_in: ["@newsletters"] } },
    ]);
    const fired: string[] = [];
    const bus = busWith(db, registry, fired);

    await bus.publish(emailEvent({ id: "gmail:1", payload: { from: "@newsletters" } }));
    expect(fired.sort()).toEqual(["all-mail", "newsletters"]);

    fired.length = 0;
    await bus.publish(emailEvent({ id: "gmail:2", payload: { from: "boss@work.com" } }));
    expect(fired).toEqual(["all-mail"]);
  });

  it("isolates one failing subscriber from the rest", async () => {
    const db = freshDb();
    const registry = fakeRegistry([
      { id: "throws", on: ["email.received"] },
      { id: "ok", on: ["email.received"] },
    ]);
    const fired: string[] = [];
    const bus = new EventBus({
      db,
      capabilities: registry,
      fire: async (id) => {
        if (id === "throws") throw new Error("boom");
        fired.push(id);
      },
    });

    const result = await bus.publish(emailEvent());

    expect(result.matched.sort()).toEqual(["ok", "throws"]);
    expect(result.dispatched).toEqual(["ok"]); // the thrower is not listed as dispatched
    expect(fired).toEqual(["ok"]);
  });
});

describe("EventBus dedup", () => {
  it("drops a second delivery of the same source id", async () => {
    const db = freshDb();
    const registry = fakeRegistry([{ id: "a", on: ["email.received"] }]);
    const fired: string[] = [];
    const bus = busWith(db, registry, fired);

    const first = await bus.publish(emailEvent({ id: "gmail:42" }));
    const second = await bus.publish(emailEvent({ id: "gmail:42" }));

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.dispatched).toEqual([]);
    expect(fired).toEqual(["a"]); // fired exactly once across both deliveries
  });

  it("marks an event seen even when nothing subscribes, so a redelivery is still dropped", async () => {
    const db = freshDb();
    const registry = fakeRegistry([{ id: "a", on: ["slack.message"] }]);
    const fired: string[] = [];
    const bus = busWith(db, registry, fired);

    const first = await bus.publish(emailEvent({ id: "gmail:7" }));
    expect(first).toMatchObject({ deduped: false, matched: [], dispatched: [] });

    const second = await bus.publish(emailEvent({ id: "gmail:7" }));
    expect(second.deduped).toBe(true);
  });

  it("treats different ids as different events", async () => {
    const db = freshDb();
    const registry = fakeRegistry([{ id: "a", on: ["email.received"] }]);
    const fired: string[] = [];
    const bus = busWith(db, registry, fired);

    await bus.publish(emailEvent({ id: "gmail:1" }));
    await bus.publish(emailEvent({ id: "gmail:2" }));

    expect(fired).toEqual(["a", "a"]);
  });
});

/**
 * Routing against the real roster: `email-triage` (no filter) and
 * `newsletter-digest` (`from_in: ["@newsletters"]`) both subscribe to
 * `email.received`, so one `email.received` event should reach both or just the
 * first depending on who sent it. Uses a spy fire; the real run is exercised end
 * to end once the bus is wired to the API.
 */
describe("EventBus against the real capabilities", () => {
  it("sends a newsletter to both triage and the digest", async () => {
    const h = harness();
    const fired: string[] = [];
    const bus = busWith(h.db, h.capabilities, fired);

    await bus.publish({
      type: "email.received",
      id: "gmail:nl-1",
      payload: { id: "nl-1", from: "@newsletters", subject: "Weekly", body: "..." },
    });

    expect(fired.sort()).toEqual(["email-triage", "newsletter-digest"]);
  });

  it("sends ordinary mail to triage only", async () => {
    const h = harness();
    const fired: string[] = [];
    const bus = busWith(h.db, h.capabilities, fired);

    await bus.publish({
      type: "email.received",
      id: "gmail:work-1",
      payload: { id: "work-1", from: "boss@work.com", subject: "Re: plan", body: "thoughts?" },
    });

    expect(fired).toEqual(["email-triage"]);
  });
});
