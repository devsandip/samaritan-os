import type { RunContext, RunResult } from "../../src/run-layer/context.js";

export interface ExtractedScreenshotEvent {
  title: string;
  starts_at: string;
  ends_at: string;
  location: string;
  timezone_ambiguous: boolean;
  date_ambiguous: boolean;
}

export interface ExistingCalendarSlot {
  id?: string;
  title: string;
  starts_at: string;
  ends_at?: string | null;
}

const TZ_OFFSETS: Record<string, string> = {
  UTC: "Z",
  GMT: "Z",
  IST: "+05:30",
  PDT: "-07:00",
  PST: "-08:00",
  PT: "-08:00",
  EDT: "-04:00",
  EST: "-05:00",
  ET: "-05:00",
};

export function extractEventFromScreenshotText(
  rawText: string,
  fallbackDate = "2026-11-02",
): ExtractedScreenshotEvent {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const firstLine = lines[0] ?? "Extracted Event from Screenshot";
  const titleMatch = /^(?:event|invite|title)[:\s]+(.+)$/i.exec(firstLine);
  const title = (titleMatch?.[1] ?? firstLine).slice(0, 120);

  const locLine =
    lines.find((l) => /^(?:location|where|venue)[:\s]+/i.test(l)) ??
    lines.find((l) => /\b(?:at|@)\s+[A-Z][A-Za-z0-9 ,.&'-]{3,}$/.test(l));
  let location = "San Francisco, CA";
  if (locLine) {
    const explicit = /^(?:location|where|venue)[:\s]+(.+)$/i.exec(locLine);
    const atMatch = /\b(?:at|@)\s+([A-Z][A-Za-z0-9 ,.&'-]{3,})$/.exec(locLine);
    location = (explicit?.[1] ?? atMatch?.[1] ?? location).trim();
  }

  const isoFull = /\b(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)\b/.exec(
    rawText,
  );
  if (isoFull?.[1]) {
    const hasTz = /(?:Z|[+-]\d{2}:\d{2})$/.test(isoFull[1]);
    const startsAt = hasTz ? isoFull[1] : `${isoFull[1]}Z`;
    const startMs = Date.parse(startsAt);
    const endsAt = Number.isNaN(startMs)
      ? "2026-11-02T20:00:00Z"
      : new Date(startMs + 5400_000).toISOString();
    return {
      title,
      starts_at: startsAt,
      ends_at: endsAt,
      location,
      timezone_ambiguous: !hasTz,
      date_ambiguous: false,
    };
  }

  const dateMatch = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(rawText);
  const datePart = dateMatch?.[1] ?? fallbackDate;
  const dateAmbiguous = !dateMatch;

  const timeMatch =
    /\b(\d{1,2})(?::(\d{2})\s*(am|pm)?|\s+(am|pm))(?:\s*(UTC|GMT|IST|PDT|PST|PT|EDT|EST|ET))?\b/i.exec(
      rawText,
    );

  let hour = 18;
  let minute = 30;
  let tzAbbrev: string | undefined;

  if (timeMatch) {
    let h = Number.parseInt(timeMatch[1]!, 10);
    const m = timeMatch[2] ? Number.parseInt(timeMatch[2], 10) : 0;
    const mer = (timeMatch[3] ?? timeMatch[4])?.toLowerCase();
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    if (h >= 0 && h <= 23) hour = h;
    if (m >= 0 && m <= 59) minute = m;
    tzAbbrev = timeMatch[5]?.toUpperCase();
  }

  const tzSuffix = (tzAbbrev && TZ_OFFSETS[tzAbbrev]) || "Z";
  const timezoneAmbiguous = !tzAbbrev;
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const startsRaw = `${datePart}T${hh}:${mm}:00${tzSuffix}`;
  const startMs = Date.parse(startsRaw);
  const startsAt = Number.isNaN(startMs) ? "2026-11-02T18:30:00Z" : new Date(startMs).toISOString();
  const endsAt = Number.isNaN(startMs)
    ? "2026-11-02T20:00:00Z"
    : new Date(startMs + 5400_000).toISOString();

  return {
    title,
    starts_at: startsAt,
    ends_at: endsAt,
    location,
    timezone_ambiguous: timezoneAmbiguous,
    date_ambiguous: dateAmbiguous,
  };
}

export function detectCalendarConflicts(
  proposed: { starts_at: string; ends_at: string },
  existingEvents: ExistingCalendarSlot[],
): string[] {
  const startA = Date.parse(proposed.starts_at);
  const endA = Date.parse(proposed.ends_at);
  if (Number.isNaN(startA) || Number.isNaN(endA)) return [];

  const conflicts: string[] = [];
  for (const ev of existingEvents) {
    const startB = Date.parse(ev.starts_at);
    if (Number.isNaN(startB)) continue;
    const endB = ev.ends_at ? Date.parse(ev.ends_at) : startB + 3600_000;
    if (startA < endB && startB < endA) {
      conflicts.push(`Overlaps with "${ev.title}" (${ev.starts_at})`);
    }
  }
  return conflicts;
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const payload = { ...ctx.inputs, ...((ctx.trigger.payload ?? {}) as Record<string, unknown>) };
  const rawOcr =
    (typeof payload.ocr_text === "string" && payload.ocr_text) ||
    (typeof payload.caption === "string" && payload.caption) ||
    (typeof payload.text === "string" && payload.text) ||
    "";

  const parsed = rawOcr ? extractEventFromScreenshotText(rawOcr) : undefined;

  const title =
    (typeof payload.title === "string" && payload.title) ||
    parsed?.title ||
    "Extracted Event from Screenshot";
  const startsAt =
    (typeof payload.starts_at === "string" && payload.starts_at) ||
    parsed?.starts_at ||
    "2026-11-02T18:30:00Z";
  const endsAt =
    (typeof payload.ends_at === "string" && payload.ends_at) ||
    parsed?.ends_at ||
    "2026-11-02T20:00:00Z";
  const location =
    (typeof payload.location === "string" && payload.location) ||
    parsed?.location ||
    "San Francisco, CA";

  const existingEvents = Array.isArray(payload.existing_events)
    ? (payload.existing_events as ExistingCalendarSlot[])
    : [];
  const conflicts = detectCalendarConflicts({ starts_at: startsAt, ends_at: endsAt }, existingEvents);

  const ambiguityFlags: string[] = [];
  if (parsed?.timezone_ambiguous && typeof payload.starts_at !== "string") {
    ambiguityFlags.push("timezone_ambiguous");
  }
  if (parsed?.date_ambiguous && typeof payload.starts_at !== "string") {
    ambiguityFlags.push("date_ambiguous");
  }

  const baseDesc =
    (typeof payload.description === "string" && payload.description) ||
    `Extracted from screenshot (${title}).`;
  const extraNotes = [
    ...(conflicts.length > 0 ? [`Conflicts: ${conflicts.join("; ")}`] : []),
    ...(ambiguityFlags.length > 0 ? [`Flags: ${ambiguityFlags.join(", ")}`] : []),
  ];
  const description = extraNotes.length > 0 ? `${baseDesc} [${extraNotes.join(" | ")}]` : baseDesc;

  const confidence =
    conflicts.length > 0 || ambiguityFlags.length > 0 ? 0.76 : 0.9;

  return {
    action_items: [
      {
        capability_id: "calendar-from-screenshot",
        type: "calendar-event-proposal",
        scope: "personal",
        context: {
          what_happened: `Extracted calendar event "${title}" (${startsAt}) from screenshot`,
          source: { kind: "screenshot", id: `screenshot:${title}:${startsAt}` },
          provenance: ["telegram.photo", "screencap.ocr"],
          why_flagged:
            conflicts.length > 0
              ? `calendar conflict detected (${conflicts[0]}); requires confirmation`
              : ambiguityFlags.length > 0
                ? `screenshot extraction has ${ambiguityFlags.join(", ")}; requires confirmation`
                : "calendar event extracted from image requires confirmation of time and location",
          trigger_reason: "policy",
          confidence,
          decision_needed: `Add "${title}" (${startsAt}) to Google Calendar?`,
          decision_surface: "inbox",
          execution_surface: "google-calendar",
          outcome_preview: `Creates "${title}" at ${startsAt} on Google Calendar`,
        },
        custom: {
          title,
          starts_at: startsAt,
          ends_at: endsAt,
          location,
          description,
        },
        dedupe_key: `calendar-screenshot:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${startsAt}`,
      },
    ],
    status: "ok",
    logs: conflicts.length > 0 ? conflicts : [],
  };
}
