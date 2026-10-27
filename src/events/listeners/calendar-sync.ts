/**
 * Google Calendar incremental sync (PROPOSAL Phase 1, Integrations table).
 *
 * Each poll pulls every change since the stored sync token, page by page, into
 * `calendar_events`. Then it looks at the table, not at the changes, to decide
 * what to announce: a sync-token poll only returns events that changed, so a
 * meeting created yesterday would never be "upcoming" if the decision rode on
 * the delta.
 *
 * Two events go onto the bus, each with an id that names the occurrence so the
 * bus's dedup fires it once:
 * - `calendar.meeting_upcoming` (`gcal:prep:<id>:<starts_at>`) when a meeting
 *   with other people is inside the prep lead window. A reschedule changes the
 *   start, so it fires again for the new time.
 * - `calendar.meeting_ended` (`gcal:ended:<id>:<ends_at>`) once it is over,
 *   which drives the "add your notes" nudge. The calendar end does not prove
 *   Sandip attended, which is why the nudge has a "no notes" answer.
 *
 * All-day entries, declined invitations and solo blocks are stored but never
 * announced. A cancelled or moved meeting retires its pending brief through
 * `onRetired`, so a stale brief does not sit in the Inbox for its ttl.
 *
 * Credentials: `gcal:<account>` in the Keychain holds either a JSON bundle
 * `{"client_id","client_secret","refresh_token"}`, from which a fresh access
 * token is minted as needed, or a bare access token (which expires in about an
 * hour; fine for a test, not for the daemon). It is read on every poll, so a
 * Keychain that was locked at boot starts working once it unlocks.
 */
import { getSecret } from "../../secrets.js";
import type { Db } from "../../store/db.js";
import { nowIso } from "../../types/index.js";
import { log } from "../../logger.js";
import type { SamaritanEvent } from "../types.js";
import type { PublishResult } from "../index.js";

const logger = log("calendar-sync");
const SOURCE = "google.calendar";

export interface CalendarEventItem {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: {
    email?: string;
    displayName?: string;
    self?: boolean;
    responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  }[];
}

export interface CalendarPage {
  items: CalendarEventItem[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** One `events.list` call. `syncToken` and `pageToken` are passed through as Google defines them. */
export type CalendarSource = (query: { syncToken?: string; pageToken?: string }) => Promise<CalendarPage>;

/** Thrown for 410 Gone: the sync token expired and a full sync is needed. */
export class SyncTokenExpired extends Error {}

interface TokenBundle {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

function accessTokenFrom(account: string, fetchFn: typeof fetch): () => Promise<string | undefined> {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    const secret = getSecret(`gcal:${account}`);
    if (!secret) return undefined;
    if (!secret.trim().startsWith("{")) return secret.trim();
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const bundle = JSON.parse(secret) as TokenBundle;
    const res = await fetchFn("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: bundle.client_id,
        client_secret: bundle.client_secret,
        refresh_token: bundle.refresh_token,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`google token refresh ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return cached.token;
  };
}

/** The real source. Undefined access token means "not configured yet", which is not an error. */
export function createGoogleCalendarSource(opts: {
  account: string;
  calendarId?: string;
  fetchImpl?: typeof fetch;
}): CalendarSource & { configured: () => boolean } {
  const fetchFn = opts.fetchImpl ?? fetch;
  const calId = encodeURIComponent(opts.calendarId ?? "primary");
  const token = accessTokenFrom(opts.account, fetchFn);

  const source = async (query: { syncToken?: string; pageToken?: string }): Promise<CalendarPage> => {
    const auth = await token();
    if (!auth) throw new Error(`no Google Calendar credential (keychain: samaritan / gcal:${opts.account})`);
    const params = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
    if (query.syncToken) params.set("syncToken", query.syncToken);
    // A full sync starts a day back; changes after that arrive through the token.
    else params.set("timeMin", new Date(Date.now() - 86_400_000).toISOString());
    if (query.pageToken) params.set("pageToken", query.pageToken);

    const res = await fetchFn(
      `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(20_000) },
    );
    if (res.status === 410) throw new SyncTokenExpired("google calendar sync token expired");
    if (!res.ok) throw new Error(`google calendar ${res.status}: ${res.statusText}`);
    const data = (await res.json()) as {
      items?: CalendarEventItem[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };
    return {
      items: data.items ?? [],
      ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
      ...(data.nextSyncToken ? { nextSyncToken: data.nextSyncToken } : {}),
    };
  };
  return Object.assign(source, { configured: () => Boolean(getSecret(`gcal:${opts.account}`)) });
}

export interface CalendarPollerDeps {
  db: Db;
  source?: CalendarSource | undefined;
  publish: (event: SamaritanEvent) => Promise<PublishResult>;
  /** A meeting was cancelled or moved: retire whatever was prepared for it. */
  onRetired?: (eventId: string, reason: "cancelled" | "rescheduled") => void;
  intervalMs?: number;
  prepLeadMinutes?: number;
  now?: () => Date;
}

interface StoredEvent {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  attendees: string | null;
  html_link: string | null;
  has_attendees: number;
}

export interface PollResult {
  synced: number;
  upcomingPublished: number;
  endedPublished: number;
}

export class CalendarPoller {
  readonly #db: Db;
  readonly #source: CalendarSource | undefined;
  readonly #publish: CalendarPollerDeps["publish"];
  readonly #onRetired: CalendarPollerDeps["onRetired"];
  readonly #intervalMs: number;
  readonly #prepLeadMinutes: number;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #inFlight = false;

  constructor(deps: CalendarPollerDeps) {
    this.#db = deps.db;
    this.#source = deps.source;
    this.#publish = deps.publish;
    this.#onRetired = deps.onRetired;
    this.#intervalMs = deps.intervalMs ?? 60_000;
    this.#prepLeadMinutes = deps.prepLeadMinutes ?? 15;
    this.#now = deps.now ?? (() => new Date());
  }

  #cursor(): string | undefined {
    return (
      this.#db.prepare<{ cursor: string | null }>("SELECT cursor FROM sync_cursors WHERE source = ?").get(SOURCE)
        ?.cursor ?? undefined
    );
  }

  #saveCursor(cursor: string | null, error: string | null): void {
    this.#db
      .prepare(
        `INSERT INTO sync_cursors (source, cursor, last_success_at, last_error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           cursor = excluded.cursor,
           last_success_at = COALESCE(excluded.last_success_at, sync_cursors.last_success_at),
           last_error = excluded.last_error`,
      )
      .run(SOURCE, cursor, error ? null : nowIso(), error);
  }

  /** Pulls every page of changes. A 410 restarts from a full sync, once. */
  async #pull(): Promise<{ items: CalendarEventItem[]; syncToken: string | undefined; full: boolean }> {
    const source = this.#source!;
    let syncToken = this.#cursor();
    for (let attempt = 0; attempt < 2; attempt++) {
      const items: CalendarEventItem[] = [];
      let pageToken: string | undefined;
      try {
        for (let page = 0; page < 40; page++) {
          const res = await source({
            ...(syncToken ? { syncToken } : {}),
            ...(pageToken ? { pageToken } : {}),
          });
          items.push(...res.items);
          if (res.nextPageToken) {
            pageToken = res.nextPageToken;
            continue;
          }
          return { items, syncToken: res.nextSyncToken, full: !syncToken };
        }
        throw new Error("google calendar returned more than 40 pages; giving up this poll");
      } catch (err) {
        if (!(err instanceof SyncTokenExpired) || !syncToken) throw err;
        logger.info("calendar sync token expired; running a full sync");
        syncToken = undefined;
      }
    }
    throw new Error("google calendar full sync failed after a 410");
  }

  #apply(
    item: CalendarEventItem,
    nowStr: string,
    rescheduledOut: {
      event_id: string;
      title: string;
      previous_starts_at: string;
      starts_at: string;
      ends_at: string | undefined;
      attendees: string[];
    }[],
  ): boolean {
    const existing = this.#db
      .prepare<{ starts_at: string }>("SELECT starts_at FROM calendar_events WHERE id = ?")
      .get(item.id);
    const self = item.attendees?.find((a) => a.self);
    const startsAt = item.start?.dateTime;

    // Cancelled, declined, or turned into an all-day entry: not a meeting any more.
    if (item.status === "cancelled" || self?.responseStatus === "declined" || !startsAt) {
      if (existing) {
        this.#db.prepare("DELETE FROM calendar_events WHERE id = ?").run(item.id);
        this.#onRetired?.(item.id, "cancelled");
      }
      return false;
    }

    const others = (item.attendees ?? [])
      .filter((a) => !a.self)
      .map((a) => a.displayName || a.email || "")
      .filter(Boolean);
    const title = item.summary?.trim() || "Untitled meeting";
    this.#db
      .prepare(
        `INSERT INTO calendar_events (id, title, starts_at, ends_at, attendees, last_synced_at, html_link, has_attendees)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
           attendees = excluded.attendees, last_synced_at = excluded.last_synced_at,
           html_link = excluded.html_link, has_attendees = excluded.has_attendees`,
      )
      .run(
        item.id,
        title,
        startsAt,
        item.end?.dateTime ?? startsAt,
        JSON.stringify(others),
        nowStr,
        item.htmlLink ?? null,
        others.length > 0 ? 1 : 0,
      );
    if (existing && Date.parse(existing.starts_at) !== Date.parse(startsAt)) {
      this.#onRetired?.(item.id, "rescheduled");
      rescheduledOut.push({
        event_id: item.id,
        title,
        previous_starts_at: existing.starts_at,
        starts_at: startsAt,
        ends_at: item.end?.dateTime,
        attendees: others,
      });
    }
    return true;
  }

  async #announce(now: Date): Promise<{ upcoming: number; ended: number }> {
    const nowMs = now.getTime();
    const windowEnd = new Date(nowMs + this.#prepLeadMinutes * 60_000).toISOString();
    const graceStart = new Date(nowMs - 5 * 60_000).toISOString();
    const rows = this.#db
      .prepare<StoredEvent>(
        `SELECT * FROM calendar_events
          WHERE has_attendees = 1
            AND ((starts_at >= ? AND starts_at <= ?) OR (ends_at <= ? AND ends_at >= ?))`,
      )
      .all(graceStart, windowEnd, now.toISOString(), new Date(nowMs - 2 * 3_600_000).toISOString());

    let upcoming = 0;
    let ended = 0;
    for (const row of rows) {
      const attendees = row.attendees ? (JSON.parse(row.attendees) as string[]) : [];
      const payload = {
        event_id: row.id,
        title: row.title,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        attendees,
        ...(row.html_link ? { html_link: row.html_link } : {}),
      };
      const startMs = Date.parse(row.starts_at);
      const endMs = Date.parse(row.ends_at ?? row.starts_at);
      if (startMs >= nowMs - 5 * 60_000 && startMs <= Date.parse(windowEnd)) {
        const res = await this.#publish({
          id: `gcal:prep:${row.id}:${row.starts_at}`,
          type: "calendar.meeting_upcoming",
          source: SOURCE,
          occurred_at: now.toISOString(),
          payload,
        });
        if (!res.deduped) upcoming++;
      }
      if (endMs <= nowMs) {
        const res = await this.#publish({
          id: `gcal:ended:${row.id}:${row.ends_at}`,
          type: "calendar.meeting_ended",
          source: SOURCE,
          occurred_at: now.toISOString(),
          payload,
        });
        if (!res.deduped) ended++;
      }
    }
    return { upcoming, ended };
  }

  async pollOnce(): Promise<PollResult> {
    const none = { synced: 0, upcomingPublished: 0, endedPublished: 0 };
    if (!this.#source || this.#inFlight) return none;
    this.#inFlight = true;
    const now = this.#now();
    try {
      const { items, syncToken, full } = await this.#pull();
      const nowStr = now.toISOString();
      let synced = 0;
      const rescheduled: {
        event_id: string;
        title: string;
        previous_starts_at: string;
        starts_at: string;
        ends_at: string | undefined;
        attendees: string[];
      }[] = [];
      this.#db.transaction(() => {
        // A full sync is the whole truth: anything not in it is gone.
        if (full) {
          const seen = new Set(items.map((i) => i.id));
          const stale = this.#db.prepare<{ id: string }>("SELECT id FROM calendar_events").all();
          for (const { id } of stale) {
            if (!seen.has(id)) {
              this.#db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
              this.#onRetired?.(id, "cancelled");
            }
          }
        }
        for (const item of items) if (item.id && this.#apply(item, nowStr, rescheduled)) synced++;
        // Old meetings are history; the vault keeps what mattered.
        this.#db
          .prepare("DELETE FROM calendar_events WHERE COALESCE(ends_at, starts_at) < ?")
          .run(new Date(now.getTime() - 7 * 86_400_000).toISOString());
        this.#saveCursor(syncToken ?? null, null);
      });
      for (const r of rescheduled) {
        await this.#publish({
          id: `gcal:rescheduled:${r.event_id}:${r.starts_at}`,
          type: "calendar.meeting_rescheduled",
          source: SOURCE,
          occurred_at: nowStr,
          payload: r,
        });
      }
      const { upcoming, ended } = await this.#announce(now);
      return { synced, upcomingPublished: upcoming, endedPublished: ended };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#saveCursor(this.#cursor() ?? null, message);
      logger.warn({ err: message }, "google calendar poll failed");
      return none;
    } finally {
      this.#inFlight = false;
    }
  }

  async start(): Promise<void> {
    if (!this.#source) return;
    await this.pollOnce();
    this.#timer = setInterval(() => void this.pollOnce(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}
