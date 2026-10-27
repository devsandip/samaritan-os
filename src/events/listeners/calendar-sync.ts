/**
 * Google Calendar incremental sync listener (PROPOSAL Phase 1).
 *
 * Polls Google Calendar's `events.list` endpoint using `syncToken` stored in
 * `sync_cursors` (`source = 'google.calendar'`), mirrors events into
 * `calendar_events`, and publishes `calendar.meeting_upcoming` onto the Event
 * Bus when a meeting is within the prep lead window.
 *
 * Reschedules update `calendar_events.starts_at` and publish under a new event
 * id (`gcal:prep:<eventId>:<startsAt>`), which `meeting-prep` ingests under the
 * stable `dedupe_key` (`meeting-prep:<eventId>`) so the existing Inbox brief is
 * superseded in place rather than duplicated.
 */
import { getSecret } from "../../secrets.js";
import type { Db } from "../../store/db.js";
import { nowIso } from "../../types/index.js";
import { log } from "../../logger.js";
import type { SamaritanEvent } from "../types.js";
import type { PublishResult } from "../index.js";

const logger = log("calendar-sync");

export interface CalendarEventItem {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean }[];
}

export interface CalendarPage {
  items: CalendarEventItem[];
  nextSyncToken?: string;
}

export type CalendarSource = (syncToken?: string) => Promise<CalendarPage>;

export function createGoogleCalendarSource(opts: {
  account: string;
  calendarId?: string;
  fetchImpl?: typeof fetch;
}): CalendarSource | undefined {
  const token = getSecret(`gcal:${opts.account}`);
  if (!token) return undefined;
  const calId = encodeURIComponent(opts.calendarId ?? "primary");
  const fetchFn = opts.fetchImpl ?? fetch;

  return async (syncToken?: string): Promise<CalendarPage> => {
    const params = new URLSearchParams({ singleEvents: "true", maxResults: "50" });
    if (syncToken) {
      params.set("syncToken", syncToken);
    } else {
      params.set("timeMin", new Date(Date.now() - 3600_000).toISOString());
    }

    const res = await fetchFn(
      `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (res.status === 410 && syncToken) {
      // 410 Gone means the syncToken expired; perform a full sync once.
      return createGoogleCalendarSource(opts)!(undefined);
    }

    if (!res.ok) {
      throw new Error(`google calendar ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as {
      items?: CalendarEventItem[];
      nextSyncToken?: string;
    };
    return {
      items: data.items ?? [],
      ...(data.nextSyncToken ? { nextSyncToken: data.nextSyncToken } : {}),
    };
  };
}

export interface CalendarPollerDeps {
  db: Db;
  source?: CalendarSource | undefined;
  publish: (event: SamaritanEvent) => Promise<PublishResult>;
  intervalMs?: number;
  prepLeadMinutes?: number;
  now?: () => Date;
}

export class CalendarPoller {
  readonly #db: Db;
  readonly #source: CalendarSource | undefined;
  readonly #publish: CalendarPollerDeps["publish"];
  readonly #intervalMs: number;
  readonly #prepLeadMinutes: number;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: CalendarPollerDeps) {
    this.#db = deps.db;
    this.#source = deps.source;
    this.#publish = deps.publish;
    this.#intervalMs = deps.intervalMs ?? 60_000;
    this.#prepLeadMinutes = deps.prepLeadMinutes ?? 20;
    this.#now = deps.now ?? (() => new Date());
  }

  async pollOnce(): Promise<{ synced: number; upcomingPublished: number }> {
    if (!this.#source) return { synced: 0, upcomingPublished: 0 };

    const cursorRow = this.#db
      .prepare<{ cursor: string | null }>(
        "SELECT cursor FROM sync_cursors WHERE source = 'google.calendar'",
      )
      .get();

    const now = this.#now();
    const nowStr = now.toISOString();

    try {
      const page = await this.#source(cursorRow?.cursor ?? undefined);
      let synced = 0;
      let upcomingPublished = 0;

      for (const item of page.items) {
        if (!item.id) continue;
        if (item.status === "cancelled") {
          this.#db.prepare("DELETE FROM calendar_events WHERE id = ?").run(item.id);
          continue;
        }

        const startsAt = item.start?.dateTime ?? item.start?.date;
        const endsAt = item.end?.dateTime ?? item.end?.date ?? startsAt;
        if (!startsAt) continue;

        const title = item.summary?.trim() || "Untitled meeting";
        const attendees = (item.attendees ?? [])
          .filter((a) => !a.self)
          .map((a) => a.displayName || a.email || "")
          .filter(Boolean);

        const existing = this.#db
          .prepare<{ starts_at: string }>("SELECT starts_at FROM calendar_events WHERE id = ?")
          .get(item.id);

        this.#db
          .prepare(
            `INSERT INTO calendar_events (id, title, starts_at, ends_at, attendees, last_synced_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               starts_at = excluded.starts_at,
               ends_at = excluded.ends_at,
               attendees = excluded.attendees,
               last_synced_at = excluded.last_synced_at`,
          )
          .run(item.id, title, startsAt, endsAt ?? null, JSON.stringify(attendees), nowStr);
        synced++;

        if (existing && existing.starts_at !== startsAt) {
          await this.#publish({
            id: `gcal:rescheduled:${item.id}:${startsAt}`,
            type: "calendar.meeting_rescheduled",
            source: "google.calendar",
            occurred_at: nowStr,
            payload: {
              event_id: item.id,
              title,
              previous_starts_at: existing.starts_at,
              starts_at: startsAt,
              ends_at: endsAt,
              attendees,
            },
          });
        }

        const startMs = Date.parse(startsAt);
        const diffMinutes = (startMs - now.getTime()) / 60_000;
        if (!Number.isNaN(diffMinutes) && diffMinutes >= -5 && diffMinutes <= this.#prepLeadMinutes) {
          const pub = await this.#publish({
            id: `gcal:prep:${item.id}:${startsAt}`,
            type: "calendar.meeting_upcoming",
            source: "google.calendar",
            occurred_at: nowStr,
            payload: {
              event_id: item.id,
              title,
              starts_at: startsAt,
              ends_at: endsAt,
              attendees,
            },
          });
          if (!pub.deduped) upcomingPublished++;
        }

        const endMs = endsAt ? Date.parse(endsAt) : Number.NaN;
        const endedMinutesAgo = (now.getTime() - endMs) / 60_000;
        if (!Number.isNaN(endedMinutesAgo) && endedMinutesAgo >= 0 && endedMinutesAgo <= 60) {
          await this.#publish({
            id: `gcal:ended:${item.id}:${endsAt}`,
            type: "calendar.meeting_ended",
            source: "google.calendar",
            occurred_at: nowStr,
            payload: {
              event_id: item.id,
              title,
              starts_at: startsAt,
              ends_at: endsAt,
              attendees,
              nudge_after_end: true,
            },
          });
        }
      }

      this.#db
        .prepare(
          `INSERT INTO sync_cursors (source, cursor, last_success_at, last_error)
           VALUES ('google.calendar', ?, ?, NULL)
           ON CONFLICT(source) DO UPDATE SET
             cursor = COALESCE(excluded.cursor, sync_cursors.cursor),
             last_success_at = excluded.last_success_at,
             last_error = NULL`,
        )
        .run(page.nextSyncToken ?? cursorRow?.cursor ?? null, nowStr);

      return { synced, upcomingPublished };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#db
        .prepare(
          `INSERT INTO sync_cursors (source, cursor, last_success_at, last_error)
           VALUES ('google.calendar', ?, NULL, ?)
           ON CONFLICT(source) DO UPDATE SET last_error = excluded.last_error`,
        )
        .run(cursorRow?.cursor ?? null, message);
      logger.warn({ err: message }, "google calendar poll failed");
      return { synced: 0, upcomingPublished: 0 };
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
