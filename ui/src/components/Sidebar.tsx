/**
 * App shell navigation (UI-SPEC §3.2).
 *
 * Counts appear on Inbox and Deferred only, and are passed in rather than
 * fetched here: the numbers have to agree with the view that owns them, and two
 * fetchers would drift the moment one of them acted on an item.
 *
 * The Ask-Samaritan box is rendered as a disabled placeholder. The recall layer
 * (PRD §15) has no endpoint yet (`src/recall/` is empty), and a search box that
 * silently does nothing is worse than one that says it is not wired up.
 */
import type { ViewName } from "../lib/router";
import { linkHandler } from "../lib/router";

interface NavItem {
  view: ViewName;
  label: string;
  count?: number;
}

export function Sidebar({
  active,
  inboxCount,
  deferredCount,
  statusLine,
}: {
  active: ViewName;
  inboxCount: number | undefined;
  deferredCount: number | undefined;
  statusLine: string;
}) {
  const items: NavItem[] = [
    { view: "dashboard", label: "Dashboard" },
    { view: "inbox", label: "Inbox", ...(inboxCount !== undefined ? { count: inboxCount } : {}) },
    {
      view: "deferred",
      label: "Deferred",
      ...(deferredCount !== undefined ? { count: deferredCount } : {}),
    },
    { view: "completed", label: "Completed" },
    { view: "settings", label: "Settings" },
  ];

  return (
    <aside className="side">
      <div className="brand">
        <div className="lg" aria-hidden="true" />
        <b>Samaritan</b>
      </div>

      <nav className="nav" aria-label="Main">
        {items.map((item) => (
          <a
            key={item.view}
            href={`/${item.view}`}
            className={active === item.view ? "active" : ""}
            onClick={linkHandler(`/${item.view}`)}
            aria-current={active === item.view ? "page" : undefined}
          >
            <span>{item.label}</span>
            {item.count !== undefined && item.count > 0 ? (
              <span className="n">{item.count}</span>
            ) : null}
          </a>
        ))}
      </nav>

      <div className="spacer" />

      <div className="recall">
        Ask Samaritan
        <br />
        <span style={{ opacity: 0.7 }}>Recall is not wired up yet.</span>
      </div>

      <small>{statusLine}</small>
    </aside>
  );
}
