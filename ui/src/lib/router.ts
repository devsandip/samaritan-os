/**
 * A ~50 line History-API router, in place of a routing dependency.
 *
 * UI-SPEC §3.3 needs exactly six addressable routes and no nesting, loaders or
 * transitions, which is less than any router library's own API surface. Fastify
 * already serves index.html for every non-/api path (`setNotFoundHandler`), so
 * real paths work on hard refresh and deep links from Telegram land correctly.
 */
import { useCallback, useEffect, useState, type MouseEvent } from "react";

export type ViewName = "dashboard" | "inbox" | "deferred" | "completed" | "settings";

export interface Route {
  view: ViewName;
  /** Present only on /inbox/:itemId. */
  itemId?: string;
  hash: string;
  path: string;
}

const VIEWS: ViewName[] = ["dashboard", "inbox", "deferred", "completed", "settings"];

export function parseRoute(path: string, hash: string): Route {
  const [head = "", tail] = path.replace(/^\/+/, "").split("/");
  const view = (VIEWS as string[]).includes(head) ? (head as ViewName) : "dashboard";
  return {
    view,
    ...(view === "inbox" && tail ? { itemId: decodeURIComponent(tail) } : {}),
    hash: hash.replace(/^#/, ""),
    path,
  };
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.hash) return;
  if (options.replace) window.history.replaceState({}, "", to);
  else window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const read = useCallback(
    () => parseRoute(window.location.pathname, window.location.hash),
    [],
  );
  const [route, setRoute] = useState<Route>(read);

  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("popstate", onChange);
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("popstate", onChange);
      window.removeEventListener("hashchange", onChange);
    };
  }, [read]);

  return route;
}

/** Intercepts a plain left-click on an internal link so it routes client-side. */
export function linkHandler(to: string) {
  return (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(to);
  };
}
