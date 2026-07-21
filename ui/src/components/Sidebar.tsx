/**
 * App shell navigation (UI-SPEC §3.2).
 *
 * Counts appear on Inbox and Deferred only, and are passed in rather than
 * fetched here: the numbers have to agree with the view that owns them, and two
 * fetchers would drift the moment one of them acted on an item.
 *
 * The Ask-Samaritan box is a real search now. Submitting navigates to `/ask`
 * with the question in the hash, so the answer is an addressable page — a deep
 * link from anywhere lands on the same result — and the answer itself renders in
 * the main pane, which has the room the sidebar does not.
 */
import { useEffect, useState, type FormEvent } from "react";
import { linkHandler, navigate, type ViewName } from "../lib/router";

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
  askQuery = "",
}: {
  active: ViewName;
  inboxCount: number | undefined;
  deferredCount: number | undefined;
  statusLine: string;
  /** The question currently on screen, so the box reflects a deep-linked ask. */
  askQuery?: string;
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

  const [draft, setDraft] = useState(askQuery);
  // Keep the box in step when the route changes under it (back/forward, a deep
  // link), without making it a controlled mirror of the URL on every keystroke.
  useEffect(() => setDraft(askQuery), [askQuery]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    if (question) navigate(`/ask#${encodeURIComponent(question)}`);
  };

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

      <form className="ask" onSubmit={submit} role="search">
        <label className="ask-label" htmlFor="ask-input">
          Ask Samaritan
        </label>
        <input
          id="ask-input"
          className="ask-input"
          type="search"
          placeholder="Ask about your notes…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Ask Samaritan a question about your notes, journals and decisions"
        />
      </form>

      <small>{statusLine}</small>
    </aside>
  );
}
