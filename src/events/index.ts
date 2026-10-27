/**
 * The Event Bus (TECH-SPEC §2.2, §12 step 18).
 *
 * The counterpart to the Scheduler. Where the Scheduler fires capabilities on a
 * clock, this fires them on something happening: a message arriving, a note
 * being written. `email-triage` and `newsletter-digest` declare `trigger.mode:
 * event` and an `on: [email.received]`, and until now those were declarations the
 * way the crons were — nothing published an event for them to answer.
 *
 * `publish()` is the whole surface. A listener (a Gmail poller, a Fireflies
 * webhook, a chokidar watch) normalises its input into a `SamaritanEvent` and
 * hands it here; the bus does two things and no more:
 *
 * 1. **Dedup at the source-event level (§2.2).** A message can arrive via both a
 *    webhook and a poll. Every event carries a stable `id`, and the bus records
 *    it before dispatching — a second delivery of the same id finds the row
 *    already there and is dropped, so the capability fires once. This is
 *    claim-before-dispatch, the same shape as the Scheduler's claim-before-fire:
 *    the id is marked seen before the run starts, so a concurrent redelivery
 *    cannot slip past. The cost is symmetric too — a crash between claim and
 *    dispatch loses that one event — and acceptable for the same reason.
 *
 * 2. **Dispatch to the matching subscribers.** Every enabled, event-mode
 *    capability whose `trigger.on` includes the event type and whose
 *    `trigger.filter` passes is run through the Run Layer with the event as its
 *    trigger payload. One subscriber failing is isolated from the others, the
 *    way the Run Layer isolates one capability from the daemon.
 *
 * The bus does not own the listeners. They are the long-lived, daemon-only part
 * (webhook routes, poll loops, filesystem watch) and start alongside the API
 * server; the bus is reachable from a request handler because a webhook route
 * calls straight into `publish()`.
 */
import { log } from "../logger.js";
import type { CapabilityRegistry } from "../registry/index.js";
import type { Db } from "../store/db.js";
import { nowIso } from "../types/index.js";
import { matchesFilter } from "./filter.js";
import type { SamaritanEvent } from "./types.js";

const logger = log("event-bus");

export interface PublishResult {
  event_id: string;
  type: string;
  /** True when this id had already been seen, so nothing was dispatched. */
  deduped: boolean;
  /** Capability ids that ran (a subscriber whose fire threw is logged, not listed). */
  dispatched: string[];
  /** Capability ids that matched the subscription — equals `dispatched` unless a fire failed. */
  matched: string[];
}

export interface EventBusDeps {
  db: Db;
  capabilities: CapabilityRegistry;
  /**
   * Runs one capability against an event. Injected rather than importing the Run
   * Layer, so the bus's routing and dedup can be tested without running real
   * capabilities. Must resolve; a rejection is caught and logged, never thrown.
   */
  fire: (capabilityId: string, event: SamaritanEvent) => Promise<void>;
  /** The clock, injected for tests. Defaults to the wall clock. */
  now?: () => string;
}

export class EventBus {
  readonly #db: Db;
  readonly #capabilities: CapabilityRegistry;
  readonly #fire: EventBusDeps["fire"];
  readonly #now: () => string;

  constructor(deps: EventBusDeps) {
    this.#db = deps.db;
    this.#capabilities = deps.capabilities;
    this.#fire = deps.fire;
    this.#now = deps.now ?? nowIso;
  }

  /**
   * Records the event id and reports whether it was new. `INSERT OR IGNORE`
   * against the primary key is the claim: exactly one of two concurrent
   * deliveries of the same id inserts a row (`changes === 1`), the other is
   * ignored (`changes === 0`) and is therefore the duplicate.
   */
  #claim(event: SamaritanEvent): boolean {
    const result = this.#db
      .prepare("INSERT OR IGNORE INTO seen_events (id, event_type, seen_at) VALUES (?, ?, ?)")
      .run(event.id, event.type, this.#now());
    return result.changes === 1;
  }

  /** Enabled, event-mode capabilities subscribed to this event type whose filter passes. */
  #subscribers(event: SamaritanEvent): string[] {
    return this.#capabilities
      .all()
      .filter((c) => c.manifest.enabled)
      .filter((c) => c.manifest.trigger.mode === "event")
      .filter((c) => (c.manifest.trigger.on ?? []).includes(event.type))
      .filter((c) => matchesFilter(c.manifest.trigger.filter, event.payload))
      .map((c) => c.manifest.id);
  }

  async publish(event: SamaritanEvent): Promise<PublishResult> {
    const base = { event_id: event.id, type: event.type };

    if (!this.#claim(event)) {
      logger.info(base, "event de-duplicated");
      return { ...base, deduped: true, dispatched: [], matched: [] };
    }

    const matched = this.#subscribers(event);
    const dispatched: string[] = [];
    for (const capabilityId of matched) {
      try {
        await this.#fire(capabilityId, event);
        dispatched.push(capabilityId);
      } catch (err) {
        logger.error(
          { capability: capabilityId, ...base, err: String(err) },
          "event dispatch failed",
        );
      }
    }

    logger.info({ ...base, matched, dispatched }, "event published");
    return { ...base, deduped: false, dispatched, matched };
  }
}
