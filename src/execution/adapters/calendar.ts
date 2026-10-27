/**
 * Google Calendar Event Creation adapter (PROPOSAL-v1 Phase 3, P3-10).
 *
 * Implements `calendar.event.create` in `assisted` and `guided` modes so
 * `calendar-from-screenshot` and scheduling capabilities can stage or create
 * events on Google Calendar with human approval.
 */
import { loadConfig } from "../../config/index.js";
import { getSecret } from "../../secrets.js";
import type {
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "../../types/index.js";
import { renderPayload } from "./guided.js";

const GCAL_API = "https://www.googleapis.com/calendar/v3";

export interface CalendarEventAdapterOptions {
  token?: () => string | undefined;
  calendarId?: string;
  fetchImpl?: typeof fetch;
}

export function createCalendarEventAdapter(
  options: CalendarEventAdapterOptions = {},
): ExecutionAdapter {
  const resolveToken =
    options.token ??
    (() => {
      const cfg = loadConfig();
      if (!cfg.calendar.enabled) return undefined;
      return getSecret(`gcal:${cfg.calendar.account}`);
    });
  const fetchFn = options.fetchImpl ?? fetch;

  return {
    id: "calendar.event.create",
    provider: "google-calendar",
    description:
      "Stages or creates a Google Calendar event in assisted or guided mode.",
    modes: ["assisted", "guided"],

    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      const payload = request.payload as {
        title?: string;
        summary?: string;
        starts_at?: string;
        ends_at?: string;
        location?: string;
        description?: string;
      };

      const title = (payload.title ?? payload.summary ?? "").trim();
      const startsAt = (payload.starts_at ?? "").trim();
      if (!title || !startsAt) {
        return {
          status: "failed",
          error: 'payload requires "title" and "starts_at"',
        };
      }

      const endsAt =
        payload.ends_at && payload.ends_at.trim()
          ? payload.ends_at.trim()
          : new Date(Date.parse(startsAt) + 3600_000).toISOString();

      const auth = resolveToken();
      if (request.mode === "guided" || !auth) {
        return {
          status: "staged",
          guided_instructions: renderPayload({
            title,
            starts_at: startsAt,
            ends_at: endsAt,
            ...(payload.location ? { location: payload.location } : {}),
            ...(payload.description ? { description: payload.description } : {}),
          }),
          guided_link: "https://calendar.google.com",
          result: { staged_event: title, starts_at: startsAt },
        };
      }

      try {
        const calId = encodeURIComponent(
          options.calendarId ?? loadConfig().calendar.calendar_id ?? "primary",
        );
        const response = await fetchFn(`${GCAL_API}/calendars/${calId}/events`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            summary: title,
            start: { dateTime: startsAt },
            end: { dateTime: endsAt },
            ...(payload.location ? { location: payload.location } : {}),
            ...(payload.description ? { description: payload.description } : {}),
          }),
        });

        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          return {
            status: "failed",
            error: `gcal ${response.status}: ${String(data["error"] ? JSON.stringify(data["error"]) : response.statusText)}`,
          };
        }

        const eventId = typeof data["id"] === "string" ? data["id"] : `gcal-${Date.now()}`;
        const htmlLink =
          typeof data["htmlLink"] === "string"
            ? data["htmlLink"]
            : "https://calendar.google.com";

        return {
          status: "staged",
          guided_instructions: `Created event "${title}" (${eventId}) on Google Calendar. Confirm once reviewed.`,
          guided_link: htmlLink,
          result: { calendar_event_id: eventId, title, starts_at: startsAt },
        };
      } catch (err) {
        return {
          status: "failed",
          error: (err as Error).message,
        };
      }
    },
  };
}
