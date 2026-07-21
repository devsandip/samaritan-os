/**
 * The Gmail listener (TECH-SPEC §2.2 "Event Bus & listeners", §12 step 18).
 *
 * The Event Bus's second real front end, after the vault watch. Where the watch
 * turns a file write into an event, this turns an arriving message into one: it
 * asks a `GmailSource` for mail newer than the last it saw, maps each through
 * `gmailMessageToEvent`, and hands the result to `publish`. `email-triage` and
 * `newsletter-digest` already subscribe to `email.received`; until now the only
 * thing that produced one was a hand `emit-event`.
 *
 * The class owns the loop and nothing else. What a message *means* is the pure
 * `gmailMessageToEvent`; where mail *comes from* is the injected `GmailSource`,
 * so the messy half — OAuth, the REST call, MIME decoding — is swappable for a
 * fake and this file is tested without a network. It starts and stops alongside
 * the API server the way the Scheduler and the vault watch do: the daemon is the
 * one long-lived process, so it is the one that can hold a poll timer open.
 *
 * Two properties matter, and both lean on machinery that already exists:
 *
 * 1. **A re-seen message fires once.** The Event Bus dedups on the event id, and
 *    the id is `gmail:<message id>` — stable across polls. So the checkpoint
 *    below is an *optimisation* (don't refetch what we've handled), never the
 *    thing that keeps a message from being filed twice. A lost checkpoint costs
 *    a refetch, not a double.
 *
 * 2. **A failure is not silently skipped past.** The high-water mark only
 *    advances over messages that published *and* are older than any that failed,
 *    so a message the bus could not take is refetched next poll rather than
 *    stranded behind a mark that moved past it.
 */
import { log } from "../../logger.js";
import type { PublishResult } from "../index.js";
import type { SamaritanEvent } from "../types.js";
import { gmailMessageToEvent, type GmailMessage } from "./gmail-message.js";

const logger = log("gmail-poll");

/** Default cadence: once a minute, the same order as the sweeps and the reindex. */
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Where the poll's high-water mark lives — the `internalDate` of the newest
 * message handled, so the next poll asks only for newer. In-memory by default
 * (durable within a run, which the bus dedup makes sufficient for correctness);
 * the daemon injects a store-backed one so a restart resumes instead of
 * refetching the whole backfill window.
 */
export interface PollCheckpoint {
  /** Epoch ms of the newest message handled, or 0 before the first poll. */
  load(): number;
  save(epochMs: number): void;
}

/** The default checkpoint: fine for one run and for tests. */
export class MemoryCheckpoint implements PollCheckpoint {
  #mark = 0;
  load(): number {
    return this.#mark;
  }
  save(epochMs: number): void {
    this.#mark = epochMs;
  }
}

/**
 * The source of mail, injected so the loop is testable without Gmail. The real
 * implementation talks to the Gmail REST API; a fake drives the tests.
 */
export interface GmailSource {
  /**
   * Messages received at or after `sinceEpochMs`, normalised. `0` means the
   * initial backfill window, whose size the adapter chooses. Order is not
   * required — the poller takes the max `internalDate` it sees as the new mark.
   * The boundary may be inclusive (Gmail's `after:` is second-granular); the bus
   * dedup absorbs a message re-seen at the boundary.
   */
  fetchSince(sinceEpochMs: number): Promise<GmailMessage[]>;
}

export interface GmailPollerDeps {
  /** Undefined when Gmail is not configured — the poller is then an idle no-op. */
  source: GmailSource | undefined;
  /** The Event Bus's `publish`. Injected so the loop can run against a spy. */
  publish: (event: SamaritanEvent) => Promise<PublishResult>;
  /** High-water persistence. Defaults to in-memory. */
  checkpoint?: PollCheckpoint;
  /** Poll cadence in ms. Defaults to 60s; a test lowers it. */
  intervalMs?: number;
}

export class GmailPoller {
  readonly #source: GmailSource | undefined;
  readonly #publish: GmailPollerDeps["publish"];
  readonly #checkpoint: PollCheckpoint;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;

  constructor(deps: GmailPollerDeps) {
    this.#source = deps.source;
    this.#publish = deps.publish;
    this.#checkpoint = deps.checkpoint ?? new MemoryCheckpoint();
    this.#intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * Begins polling. With no source the poller is idle — the vault watch's
   * "no roots present" case, one level up: Gmail not configured must not stop the
   * daemon. Otherwise it polls once immediately, so mail that arrived while the
   * process was down is handled at boot rather than up to a minute later, then on
   * the interval. `unref` keeps the timer from holding the process open.
   */
  async start(): Promise<void> {
    if (!this.#source) {
      logger.info("gmail not configured; poller idle");
      return;
    }
    await this.poll();
    this.#timer = setInterval(() => void this.poll(), this.#intervalMs);
    this.#timer.unref();
    logger.info({ intervalMs: this.#intervalMs }, "polling gmail");
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One poll. Re-entrancy is guarded so a slow fetch cannot overlap the next
   * tick, and a whole-poll failure (the fetch threw) logs and waits for the next
   * tick rather than taking the daemon down — the same guard the sweep and the
   * reindex use. Per-message failures are isolated and hold the high-water mark
   * back (see the file header), so a message the bus rejected is retried.
   */
  async poll(): Promise<void> {
    if (!this.#source || this.#polling) return;
    this.#polling = true;
    try {
      const since = this.#checkpoint.load();
      const messages = await this.#source.fetchSince(since);

      let highWater = since;
      let failedFloor = Infinity;
      for (const message of messages) {
        const ms = Number(message.internalDate);
        // Undated mail (real Gmail always dates it) is pinned at `since` so it
        // never advances the mark on its own — it refetches until it publishes.
        const at = Number.isFinite(ms) ? ms : since;
        try {
          await this.#publish(gmailMessageToEvent(message));
          if (at > highWater) highWater = at;
        } catch (err) {
          if (at < failedFloor) failedFloor = at;
          logger.error({ id: message.id, err: String(err) }, "publish from gmail poll failed");
        }
      }

      // Never move past the oldest failure, so it is refetched next poll.
      const newMark = Math.min(highWater, failedFloor);
      if (newMark > since) this.#checkpoint.save(newMark);
      if (messages.length) logger.info({ count: messages.length, since }, "gmail polled");
    } catch (err) {
      logger.error({ err: String(err) }, "gmail poll failed");
    } finally {
      this.#polling = false;
    }
  }
}
