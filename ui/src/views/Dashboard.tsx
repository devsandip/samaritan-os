/**
 * Dashboard (UI-SPEC §5.1) — "what's the state of my world" in one screenful.
 *
 * Every number here is derived from data the views below it already fetch, so
 * the Dashboard can never disagree with the Inbox.
 *
 * "Last run" used to be approximated from item timestamps because no run-layer
 * telemetry existed. It now comes from the `capabilities` row the Run Layer
 * writes, so a capability that ran and emitted nothing is distinguishable from
 * one that never ran, which the approximation could not do.
 *
 * The auto-handled feed is still reconstructed, from items that reached
 * `executed` without ever waiting on Sandip.
 */
import { useState } from "react";
import { api } from "../api/client";
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
  onToast,
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
  onToast: (message: string, variant?: "ok" | "err") => void;
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
            {capabilities.map((capability) => (
              <AgentCard
                key={capability.id}
                capability={capability}
                pending={pendingByCapability.get(capability.id) ?? 0}
                onRan={reload}
                onToast={onToast}
              />
            ))}
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

/**
 * One capability (UI-SPEC §6.3), with the ability to fire it.
 *
 * "Run now" is the only place in the UI that makes something happen without an
 * action item existing first, and it is deliberately not an exception to the
 * review gate: the run emits, policy decides, and whatever needed a human turns
 * up in the Inbox a moment later. Running an agent and approving its output
 * stay two separate acts.
 *
 * `last run` comes from the Run Layer's telemetry rather than being inferred
 * from item timestamps, which is what this card used to do.
 */
function AgentCard({
  capability,
  pending,
  onRan,
  onToast,
}: {
  capability: CapabilityManifest;
  pending: number;
  onRan: () => void;
  onToast: (message: string, variant?: "ok" | "err") => void;
}) {
  const [running, setRunning] = useState(false);

  const degraded = capability.types?.some((type) => type.degraded_reason);
  const failed = capability.last_run_status && capability.last_run_status !== "ok";
  const state = !capability.enabled ? "idle" : degraded || failed ? "err" : "ok";

  const run = async () => {
    setRunning(true);
    try {
      const report = await api.runCapability(capability.id);
      const waiting = report.accepted.filter((a) => a.status === "pending").length;
      const auto = report.accepted.filter((a) => a.status === "executed").length;

      if (report.status !== "ok") {
        onToast(`${capability.name}: ${report.error ?? report.status}`, "err");
      } else if (!report.accepted.length) {
        // A run that emits nothing is a normal outcome, not a failure. Triage
        // deciding three messages need no reply is the system working.
        onToast(`${capability.name} ran, nothing to surface`);
      } else {
        const parts = [
          waiting ? `${waiting} for you` : "",
          auto ? `${auto} handled automatically` : "",
        ].filter(Boolean);
        onToast(`${capability.name}: ${parts.join(", ")}`);
      }
      onRan();
    } catch (err) {
      onToast(`Could not run ${capability.name}: ${(err as Error).message}`, "err");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={state === "err" ? "agent err" : "agent"} title={capability.description}>
      <div className="top">
        <StatusDot
          state={state}
          label={!capability.enabled ? "disabled" : degraded ? "degraded" : "active"}
        />
        <b>{capability.name}</b>
        <button className="link" type="button" onClick={run} disabled={running}>
          {running ? "running…" : "Run now"}
        </button>
      </div>
      <div className="meta">
        {capability.trigger.mode}
        {capability.trigger.command ? ` (${capability.trigger.command})` : ""} ·{" "}
        {capability.last_run_at
          ? `last run ${relativeTime(capability.last_run_at)}${
              failed ? ` (${capability.last_run_status})` : ""
            }`
          : "never run"}
        <br />
        {pending > 0 ? <span className="pend">{pending} waiting for you</span> : "nothing waiting"}
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
}
