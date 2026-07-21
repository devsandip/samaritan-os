import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { repoRoot } from "../src/config/index.js";
import type { PublishResult } from "../src/events/index.js";
import type { GmailMessage } from "../src/events/listeners/gmail-message.js";
import {
  GmailPoller,
  MemoryCheckpoint,
  type GmailSource,
  type PollCheckpoint,
} from "../src/events/listeners/gmail-poll.js";
import type { SamaritanEvent } from "../src/events/types.js";
import { listActionItems } from "../src/store/action-items.js";

/**
 * The loop the pure mapper cannot cover: that a fetch becomes publishes, that the
 * checkpoint advances so the next poll asks only for newer, and that a message the
 * bus rejects is not stranded behind a mark that moved past it.
 */

function msg(id: string, internalDate: number, extra: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id,
    internalDate: String(internalDate),
    headers: { from: "ada@example.com", subject: `subject ${id}` },
    body: `body ${id}`,
    ...extra,
  };
}

/** A source that hands out queued batches and records the `since` of each poll. */
class FakeSource implements GmailSource {
  readonly sinces: number[] = [];
  constructor(private readonly batches: GmailMessage[][]) {}
  async fetchSince(since: number): Promise<GmailMessage[]> {
    this.sinces.push(since);
    return this.batches.shift() ?? [];
  }
}

class RecordingCheckpoint implements PollCheckpoint {
  readonly saves: number[] = [];
  #mark = 0;
  load(): number {
    return this.#mark;
  }
  save(ms: number): void {
    this.#mark = ms;
    this.saves.push(ms);
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("GmailPoller", () => {
  let poller: GmailPoller | undefined;
  let published: SamaritanEvent[];
  let failId: string | undefined;

  const publish = async (event: SamaritanEvent): Promise<PublishResult> => {
    if (event.payload.id === failId) throw new Error("bus rejected");
    published.push(event);
    return { event_id: event.id, type: event.type, deduped: false, dispatched: [], matched: [] };
  };

  const make = (deps: Partial<ConstructorParameters<typeof GmailPoller>[0]>): GmailPoller => {
    published = [];
    return new GmailPoller({ source: undefined, publish, intervalMs: 20, ...deps });
  };

  afterEach(() => {
    poller?.stop();
    poller = undefined;
    failId = undefined;
  });

  it("is an idle no-op when Gmail is not configured", async () => {
    poller = make({ source: undefined });
    await poller.start();
    expect(published).toEqual([]);
  });

  it("publishes an email.received for each fetched message", async () => {
    const source = new FakeSource([[msg("a", 100), msg("b", 200)]]);
    poller = make({ source });
    await poller.poll();

    expect(published.map((e) => e.id)).toEqual(["gmail:a", "gmail:b"]);
    expect(published[0]).toMatchObject({ type: "email.received", source: "gmail" });
    expect(published[0].payload).toMatchObject({ id: "a", from: "ada@example.com" });
  });

  it("advances the checkpoint to the newest message, so the next poll asks only for newer", async () => {
    const checkpoint = new RecordingCheckpoint();
    const source = new FakeSource([[msg("a", 100), msg("b", 300), msg("c", 200)]]);
    poller = make({ source, checkpoint });

    await poller.poll();
    expect(checkpoint.saves).toEqual([300]);
    expect(source.sinces).toEqual([0]);

    await poller.poll();
    expect(source.sinces).toEqual([0, 300]); // resumed from the mark, not 0
  });

  it("isolates a failed publish and holds the mark back so it is refetched", async () => {
    const checkpoint = new RecordingCheckpoint();
    // The older message (100) fails; the newer (200) succeeds. The mark must not
    // move past 100, or the failed one is lost.
    const source = new FakeSource([[msg("old", 100), msg("new", 200)]]);
    failId = "old";
    poller = make({ source, checkpoint });

    await poller.poll();

    expect(published.map((e) => e.payload.id)).toEqual(["new"]); // the other still went
    expect(checkpoint.saves).toEqual([100]); // capped at the failure, not 200
  });

  it("does not overlap a slow poll with the next tick", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = () => r()));
    const source: GmailSource = {
      sinces: [] as number[],
      async fetchSince(since: number) {
        (this.sinces as number[]).push(since);
        await gate;
        return [];
      },
    } as GmailSource & { sinces: number[] };

    poller = make({ source, checkpoint: new MemoryCheckpoint() });
    const first = poller.poll();
    await poller.poll(); // re-entrant call while the first is still awaiting the gate

    expect((source as unknown as { sinces: number[] }).sinces).toEqual([0]); // only one fetch in flight
    release?.();
    await first;
  });

  it("keeps polling on its interval until stopped", async () => {
    const source = new FakeSource([[msg("first", 100)], [msg("second", 200)]]);
    poller = make({ source, intervalMs: 15 });

    await poller.start(); // immediate poll drains batch 1
    await waitFor(() => published.some((e) => e.payload.id === "second")); // batch 2 via the interval

    poller.stop();
    const seen = published.length;
    await waitFor(() => true, 40).catch(() => undefined);
    expect(published.length).toBe(seen); // no further polls after stop
  });

  it("survives a fetch that throws and recovers on the next poll", async () => {
    let calls = 0;
    const source: GmailSource = {
      async fetchSince() {
        calls++;
        if (calls === 1) throw new Error("network down");
        return [msg("later", 500)];
      },
    };
    poller = make({ source });

    await poller.poll(); // throws internally, swallowed
    expect(published).toEqual([]);

    await poller.poll(); // recovers
    expect(published.map((e) => e.payload.id)).toEqual(["later"]);
  });
});

/**
 * The whole chain, against the real app: a Gmail message, through the poller,
 * onto the real Event Bus, into the real Run Layer, out as a real Inbox item —
 * the same path a hand `emit-event` proves, entered from the listener end. This
 * is the "only contact with the real system" test the project keeps insisting on:
 * the fake stops at the source, everything after it is production code.
 */
describe("GmailPoller end to end", () => {
  it("turns a fetched message into a reviewable email item", async () => {
    const app = createApp({ dbPath: ":memory:", capabilitiesDir: join(repoRoot(), "capabilities") });
    try {
      const source = new FakeSource([
        [
          msg("real-1", 1753000000000, {
            headers: { from: "Priya <priya@work.com>", subject: "Deck" },
            body: "Could you review the deck before Friday? Thanks.",
          }),
        ],
      ]);
      const poller = new GmailPoller({ source, publish: (e) => app.eventBus.publish(e) });

      await poller.poll();

      const items = listActionItems(app.db, { status: "pending" });
      const triaged = items.find((i) => i.capability_id === "email-triage");
      expect(triaged).toBeDefined();
      expect(triaged?.type).toBe("email-reply-review");
    } finally {
      app.close();
    }
  });
});
