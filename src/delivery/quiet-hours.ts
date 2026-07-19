/**
 * Quiet hours (TECH-SPEC §2.2).
 *
 * Delivery queues instead of pushing inside the window and flushes after it.
 * Split out from the Telegram client so the window arithmetic, which is the part
 * that is easy to get wrong across midnight, can be tested on its own.
 */

export interface QuietWindow {
  startMinutes: number;
  endMinutes: number;
}

export function parseQuietHours(spec: string): QuietWindow {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(spec.trim());
  if (!match) throw new Error(`invalid quiet_hours "${spec}"; expected a form like "22:00-07:00"`);
  const [, sh, sm, eh, em] = match;
  const startMinutes = Number(sh) * 60 + Number(sm);
  const endMinutes = Number(eh) * 60 + Number(em);
  if (startMinutes > 1439 || endMinutes > 1439) throw new Error(`invalid quiet_hours "${spec}"`);
  return { startMinutes, endMinutes };
}

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * A window whose end is before its start wraps midnight, which is the normal
 * case: "22:00-07:00" means late evening through early morning, not the 15 hours
 * in between.
 */
export function isWithinQuietHours(now: Date, window: QuietWindow): boolean {
  const minute = minutesOfDay(now);
  const { startMinutes, endMinutes } = window;
  if (startMinutes === endMinutes) return false;
  return startMinutes < endMinutes
    ? minute >= startMinutes && minute < endMinutes
    : minute >= startMinutes || minute < endMinutes;
}

/** The next moment the window is open, for scheduling a queued notification. */
export function quietHoursEnd(now: Date, window: QuietWindow): Date {
  const end = new Date(now);
  end.setSeconds(0, 0);
  end.setHours(Math.floor(window.endMinutes / 60), window.endMinutes % 60);
  if (end <= now) end.setDate(end.getDate() + 1);
  return end;
}
