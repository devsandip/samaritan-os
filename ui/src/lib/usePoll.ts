/**
 * Re-runs `tick` every `ms` while `active` and the tab is visible.
 *
 * Background work (a delegated task, a run, a sync) changes state without the
 * UI asking, so the views that show it refresh on a timer. A hidden tab skips
 * ticks, so a phone left on the Now view does not keep polling in a pocket.
 */
import { useEffect, useRef } from "react";

export function usePoll(tick: () => void, ms: number, active = true): void {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") latest.current();
    }, ms);
    return () => window.clearInterval(timer);
  }, [ms, active]);
}
