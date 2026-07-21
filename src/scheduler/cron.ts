/**
 * A standard five-field cron parser and next-fire calculator (TECH-SPEC §12
 * step 17).
 *
 * The spec names `node-cron`. This is the deviation logged in DECISIONS.md: a
 * self-contained matcher instead of the library, for three reasons the library
 * cannot give us.
 *
 * 1. `next_fire_at`. The `triggers` table has had this column since migration 1
 *    and nothing ever filled it. node-cron schedules an opaque callback and
 *    never tells you when it will next run, so the Dashboard could not show
 *    "next run in 3h" and §8's staleness check ("a row that hasn't pushed within
 *    its expected interval is greyed") would have nothing to compare against.
 * 2. Catch-up across a restart (§11). node-cron's timer dies with the process,
 *    so a missed daily digest is simply lost. A persisted next-fire time turns
 *    "were we down when this was due?" into a comparison, which is the whole
 *    mechanism behind `catch_up: run_once`.
 * 3. Deterministic tests. Every time-based component in this codebase injects
 *    its clock and asserts exact behaviour; a matcher that is a pure function of
 *    (schedule, date) fits that, an internal wall-clock timer does not.
 *
 * The module imports nothing from the rest of the project on purpose: it is a
 * leaf that `types/manifest.ts` can validate against without a cycle.
 *
 * Semantics are Vixie cron, evaluated in the host's local time (a personal OS on
 * one Mac; "0 8 * * *" means 8am where Sandip is). The one rule worth stating:
 * when BOTH day-of-month and day-of-week are restricted, a day matches if
 * EITHER matches, not both — so "0 0 1 * 1" fires on the 1st and on every
 * Monday. If only one is restricted, only that one is consulted.
 */

/** A parsed cron expression: each field expanded to the exact set of values it permits. */
export interface CronSchedule {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /**
   * Whether the field was written as anything other than `*`. The OR rule above
   * keys on this: an unrestricted field (`*`) drops out of the day test entirely.
   */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

interface FieldRange {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const MINUTE: FieldRange = { name: "minute", min: 0, max: 59 };
const HOUR: FieldRange = { name: "hour", min: 0, max: 23 };
const DAY_OF_MONTH: FieldRange = { name: "day-of-month", min: 1, max: 31 };
const MONTH: FieldRange = { name: "month", min: 1, max: 12 };
// Day-of-week accepts 0-7, where both 0 and 7 mean Sunday. 7 is normalised to 0
// so it lines up with JavaScript's Date.getDay().
const DAY_OF_WEEK: FieldRange = { name: "day-of-week", min: 0, max: 7 };

/**
 * Expands one field (`*`, `5`, `1-4`, `*​/15`, `1-20/5`, `0,15,30,45`, or any
 * comma-separated mix) into the set of numbers it permits.
 *
 * Throws with the field name and the offending token, because a malformed cron
 * should fail when the manifest loads, not silently never fire at 2am.
 */
function parseField(raw: string, range: FieldRange): Set<number> {
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "") {
      throw new Error(`${range.name}: empty term in "${raw}"`);
    }

    // Split off an optional step: `<range>/<step>`.
    const [rangeToken, stepToken, ...extra] = token.split("/");
    if (extra.length > 0 || rangeToken === undefined) {
      throw new Error(`${range.name}: malformed term "${token}"`);
    }

    let step = 1;
    if (stepToken !== undefined) {
      step = Number(stepToken);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`${range.name}: step must be a positive integer, got "${stepToken}"`);
      }
    }

    let lo: number;
    let hi: number;
    if (rangeToken === "*") {
      lo = range.min;
      hi = range.max;
    } else if (rangeToken.includes("-")) {
      const [a, b, ...rest] = rangeToken.split("-");
      if (rest.length > 0 || a === undefined || b === undefined) {
        throw new Error(`${range.name}: malformed range "${rangeToken}"`);
      }
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangeToken);
      hi = lo;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`${range.name}: non-integer value in "${token}"`);
    }
    if (lo > hi) {
      throw new Error(`${range.name}: range start ${lo} is after end ${hi}`);
    }
    if (lo < range.min || hi > range.max) {
      throw new Error(
        `${range.name}: value out of range (${range.min}-${range.max}) in "${token}"`,
      );
    }

    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  return values;
}

/** Parses a five-field cron string. Throws a descriptive error on anything malformed. */
export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length} in "${expr}"`,
    );
  }
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];

  const daysOfWeek = new Set<number>();
  for (const v of parseField(dow, DAY_OF_WEEK)) daysOfWeek.add(v === 7 ? 0 : v);

  return {
    source: expr.trim(),
    minutes: parseField(min, MINUTE),
    hours: parseField(hour, HOUR),
    daysOfMonth: parseField(dom, DAY_OF_MONTH),
    months: parseField(month, MONTH),
    daysOfWeek,
    domRestricted: dom.trim() !== "*",
    dowRestricted: dow.trim() !== "*",
  };
}

/** True if the expression parses. Used by the manifest schema to reject a bad cron at load. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

/** Applies the day-of-month / day-of-week OR rule to a concrete date. */
function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const domOk = schedule.daysOfMonth.has(date.getDate());
  const dowOk = schedule.daysOfWeek.has(date.getDay());
  if (schedule.domRestricted && schedule.dowRestricted) return domOk || dowOk;
  if (schedule.domRestricted) return domOk;
  if (schedule.dowRestricted) return dowOk;
  return true;
}

/** True if `date` (to the minute) satisfies every field of the schedule. */
export function matches(schedule: CronSchedule, date: Date): boolean {
  return (
    schedule.minutes.has(date.getMinutes()) &&
    schedule.hours.has(date.getHours()) &&
    schedule.months.has(date.getMonth() + 1) &&
    dayMatches(schedule, date)
  );
}

// Five years is comfortably past the worst honest cron (Feb 29 constrained to a
// weekday recurs on a 5-6 year cycle) and short enough that an impossible
// expression fails fast instead of spinning.
const SEARCH_HORIZON_YEARS = 5;

/**
 * The first minute strictly after `after` that the schedule fires on.
 *
 * Field-jumping rather than minute-stepping: a month mismatch skips to the 1st
 * of the next month, a day mismatch skips to tomorrow, and so on. Each mismatch
 * advances a whole field, so this settles in a few thousand iterations at worst
 * rather than the ~half-million a naive minute-by-minute scan of a year would
 * take.
 *
 * Throws if nothing matches within the horizon, which for a validated
 * expression means an impossible date like "0 0 30 2 *" (Feb 30). That is a
 * caller error worth surfacing, not a silent null the scheduler would treat as
 * "never due".
 */
export function nextFireAfter(schedule: CronSchedule, after: Date): Date {
  const t = new Date(after.getTime());
  // Align to the next whole minute: cron has minute granularity, and "strictly
  // after" keeps a fire from re-matching the very minute it just ran in.
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);

  const horizon = new Date(after.getTime());
  horizon.setFullYear(horizon.getFullYear() + SEARCH_HORIZON_YEARS);

  while (t.getTime() <= horizon.getTime()) {
    if (!schedule.months.has(t.getMonth() + 1)) {
      // setMonth with day=1 rolls the year over correctly from December.
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(schedule, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hours.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minutes.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }

  throw new Error(
    `"${schedule.source}" has no matching time within ${SEARCH_HORIZON_YEARS} years of ${after.toISOString()}`,
  );
}
