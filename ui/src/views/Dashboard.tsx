/**
 * Dashboard (UI-SPEC §5.1) — "what's the state of my world" in one screenful.
 *
 * Every number here is derived from data the views below it already fetch, so
 * the Dashboard can never disagree with the Inbox. Two things §5.1 asks for are
 * approximated and say so on screen rather than being faked: the agent grid's
 * "last run" (no run-layer telemetry exists yet, `src/run-layer/` is empty), and
 * the auto-handled feed, which is reconstructed from items that reached
 * `executed` without ever being pending long enough to need Sandip.
 */
import type { ActionItem, CapabilityManifest, LoadProblem } from "../api/types";
import type { ApiError } from "../api/client";
import { EmptyState, ErrorBanner, Skeleton, SkeletonRows } from "../components/states";
import { StatusDot } from "../components/primitives";
import type { Catalogue } from "../lib/manifest";
import { itemTitle } from "../lib/manifest";
import { byPriorityThenNewest, clockTime, greeting, relativeTime } from "../lib/format";
import { navigate } from "../lib/router";

export function DashboardView({
  inbox,
  deferred,
  autoHandled,
  capabilities,
  problems,
  catalogue,
  loading,
  error,
  reload,
}: {
  inbox: ActionItem[] | undefined;
  deferred: ActionItem[] | undefined;
  autoHandled: ActionItem[] | undefined;
  capabilities: CapabilityManifest[];
  problems: LoadProblem[];
  catalogue: Catalogue;
  loading: boolean;
  error: ApiError | undefined;
  reload: () => void;
}) {
  const items = [...(inbox ?? [])].sort(byPriorityThenNewest);
  const urgent = items.filter((item) => item.priority === "urgent" || item.priority === "high");
  const today = (autoHandled ?? []).filter(isToday);
  const pendingByCapability = catalogue.pendingByCapability(items);

  const enabled = capabilities.filter((capability) => capability.enabled);

  return (
    <>
      <h1 className="h-greet">{greeting()}, Sandip</h1>
      <p className="h-sub">
        {new Date().toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        })}
        {" · "}
        {items.length} {items.length === 1 ? "thing needs" : "things need"} you,{" "}
        {today.length} handled automatically today.
      </p>

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}
      {problems.length > 0 ? (
        <div className="banner" role="alert">
          <div className="msg">
            <div>
              {problems.length} {problems.length === 1 ? "capability" : "capabilities"} failed to
              load.
            </div>
            <div className="detail-text">
              {problems.map((problem) => `${problem.capabilityId ?? problem.dir}: ${problem.message}`).join(" · ")}
            </div>
          </div>
        </div>
      ) : null}

      <div className={error ? "tiles dimmed" : "tiles"}>
        {loading && !inbox ? (
          <>
            <Skeleton variant="tile" count={4} />
          </>
        ) : (
          <>
            <Tile
              label="Needs you"
              value={items.length}
              sub={urgent.length > 0 ? `${urgent.length} urgent or high` : "nothing urgent"}
              alert={urgent.length > 0}
            />
            <Tile
              label="Auto-handled today"
              value={today.length}
              sub="no action needed"
            />
            <Tile
              label="Deferred"
              value={deferred?.length ?? 0}
              sub={deferred?.length ? "waiting for you to come back" : "nothing snoozed"}
            />
            <Tile
              label="Capabilities"
              value={`${enabled.length} / ${capabilities.length}`}
              sub={problems.length > 0 ? `${problems.length} failed to load` : "all loaded"}
            />
          </>
        )}
      </div>

      <div className="card">
        <h2>
          Plugged-in capabilities
          <button className="link" type="button" onClick={() => navigate("/settings")}>
            Settings
          </button>
        </h2>
        {capabilities.length === 0 ? (
          <EmptyState left>
            No capabilities yet. Drop one into <code>capabilities/</code> and reload the daemon.
          </EmptyState>
        ) : (
          <div className="agents">
            {capabilities.map((capability) => {
              const degraded = capability.types?.some((type) => type.degraded_reason);
              const pending = pendingByCapability.get(capability.id) ?? 0;
              return (
                <div
                  className={degraded ? "agent err" : "agent"}
                  key={capability.id}
                  title={capability.description}
                >
                  <div className="top">
                    <StatusDot
                      state={!capability.enabled ? "idle" : degraded ? "err" : "ok"}
                      label={!capability.enabled ? "disabled" : degraded ? "degraded" : "active"}
                    />
                    <b>{capability.name}</b>
                  </div>
                  <div className="meta">
                    {capability.trigger.mode}
                    {capability.trigger.command ? ` (${capability.trigger.command})` : ""} ·{" "}
                    {capability.enabled ? "enabled" : "disabled"}
                    <br />
                    {pending > 0 ? (
                      <span className="pend">{pending} waiting for you</span>
                    ) : (
                      "nothing waiting"
                    )}
                    {degraded ? (
                      <>
                        <br />
                        degraded to guided:{" "}
                        {capability.types.find((type) => type.degraded_reason)?.degraded_reason}
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid2">
        <div className="card">
          <h2>
            Needs you now
            <button className="link" type="button" onClick={() => navigate("/inbox")}>
              Open inbox
            </button>
          </h2>
          {loading && !inbox ? (
            <SkeletonRows count={3} />
          ) : items.length === 0 ? (
            <EmptyState>Nothing needs you right now.</EmptyState>
          ) : (
            items.slice(0, 6).map((item) => (
              <button
                type="button"
                className="qrow"
                key={item.id}
                onClick={() => navigate(`/inbox/${item.id}`)}
              >
                <span
                  className={
                    item.priority === "urgent" || item.priority === "high" ? "prio u" : "prio n"
                  }
                  aria-hidden="true"
                />
                <span className="t">
                  {itemTitle(item, catalogue.resolveItem(item))}
                  <small>{item.context.why_flagged || item.context.decision_needed}</small>
                </span>
                <span className="tag">{item.context.source.kind || item.capability_id}</span>
              </button>
            ))
          )}
        </div>

        <div className="card">
          <h2>Handled automatically today</h2>
          {loading && !autoHandled ? (
            <SkeletonRows count={3} />
          ) : today.length === 0 ? (
            <EmptyState left>Nothing was auto-handled today.</EmptyState>
          ) : (
            today.slice(0, 8).map((item) => (
              <div className="frow" key={item.id}>
                <span className="tm">{clockTime(item.updated_at)}</span>
                <span style={{ flex: 1 }}>
                  {itemTitle(item, catalogue.resolveItem(item))}
                  <br />
                  <span className="who">{item.capability_id}</span>
                </span>
              </div>
            ))
          )}
          <div className="trust-note">
            Auto-handled means high-confidence, low-blast-radius and reversible. Everything else is
            escalated to your inbox.
          </div>
        </div>
      </div>

      {deferred && deferred.length > 0 ? (
        <div className="card">
          <h2>
            Deferred
            <button className="link" type="button" onClick={() => navigate("/deferred")}>
              See all
            </button>
          </h2>
          {deferred.slice(0, 3).map((item) => (
            <div className="frow" key={item.id}>
              <span className="tm">{relativeTime(item.updated_at)}</span>
              <span style={{ flex: 1 }}>{itemTitle(item, catalogue.resolveItem(item))}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function Tile({
  label,
  value,
  sub,
  alert,
}: {
  label: string;
  value: number | string;
  sub: string;
  alert?: boolean;
}) {
  return (
    <div className={alert ? "tile alert" : "tile"}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

function isToday(item: ActionItem): boolean {
  const at = new Date(Date.parse(item.updated_at));
  const now = new Date();
  return (
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  );
}
