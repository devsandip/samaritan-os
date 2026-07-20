/**
 * Settings (UI-SPEC §5.5).
 *
 * §5.5's "Connections" grid is per-integration (Gmail, Notion, ...), but v0 has
 * no connection registry to read: the daemon only knows capabilities and the
 * execution ids they require. So the grid renders capabilities and the execution
 * targets each one depends on, using the same card component §6.3/§6.10 share.
 * When a connections endpoint lands, this card swaps its data source and keeps
 * its markup.
 *
 * The routing table is real: `PUT /api/routing/:action_type` is live, including
 * the 409 on a locked entry, which is surfaced verbatim because the money lock
 * (§9) is exactly the rule a user should see enforced rather than hidden.
 */
import { useState } from "react";
import { ApiError, api } from "../api/client";
import type { CapabilityManifest, ExecutionMode, LoadProblem, RoutingEntry } from "../api/types";
import { Badge, StatusDot } from "../components/primitives";
import { EmptyState, ErrorBanner, ErrorStrip, Skeleton, SkeletonRows } from "../components/states";
import { MODE_LABEL } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const MODES: ExecutionMode[] = ["guided", "assisted", "automated"];

const MODE_VARIANT = {
  guided: "guided",
  assisted: "assist",
  automated: "auto",
} as const;

export function SettingsView({
  capabilities,
  problems,
  loading,
  error,
  reload,
  onToast,
}: {
  capabilities: CapabilityManifest[];
  problems: LoadProblem[];
  loading: boolean;
  error: ApiError | undefined;
  reload: () => void;
  onToast: (message: string, variant?: "ok" | "err") => void;
}) {
  const routing = useAsync(() => api.routing(), []);
  const [savingType, setSavingType] = useState<string | undefined>(undefined);
  const [rescanning, setRescanning] = useState(false);
  const [routingError, setRoutingError] = useState<string | undefined>(undefined);

  /**
   * Re-walks capabilities/ without a restart.
   *
   * This is the "plug in an agent" gesture made visible. The registry already
   * supported it (POST /api/capabilities/reload); nothing in the UI called it,
   * so the only way to pick up a new folder was to restart the daemon, which
   * made a pluggable system look like it was not.
   */
  const rescan = async () => {
    setRescanning(true);
    try {
      const result = await api.reloadCapabilities();
      const failed = result.problems.length;
      onToast(
        failed
          ? `${result.reloaded.length} loaded, ${failed} failed. See the banner.`
          : `${result.reloaded.length} capabilities loaded.`,
        failed ? "err" : "ok",
      );
      reload();
    } catch (err) {
      onToast(`Rescan failed: ${(err as Error).message}`, "err");
    } finally {
      setRescanning(false);
    }
  };

  const changeMode = async (entry: RoutingEntry, mode: ExecutionMode) => {
    setSavingType(entry.action_type);
    setRoutingError(undefined);
    try {
      await api.updateRouting(entry.action_type, { mode });
      onToast(`${entry.action_type} is now ${MODE_LABEL[mode]}`);
      routing.reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setRoutingError(message);
      onToast(message, "err");
    } finally {
      setSavingType(undefined);
    }
  };

  return (
    <>
      <h1 className="h-greet">Settings</h1>
      <p className="h-sub">
        What is plugged in, and how much autonomy each action type has.
      </p>

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}

      <div className="card">
        <h2>
          Capabilities
          <button className="link" type="button" onClick={rescan} disabled={rescanning}>
            {rescanning ? "rescanning…" : "Rescan capabilities/"}
          </button>
        </h2>
        <p className="detail-text" style={{ marginTop: 0 }}>
          Adding one is dropping a folder into <code>capabilities/</code> with a{" "}
          <code>manifest.yaml</code> and an <code>index.ts</code>. Scaffold it with{" "}
          <code>pnpm new-capability &lt;id&gt;</code>, then rescan. No restart, no code to
          register it anywhere.
        </p>
        {loading && capabilities.length === 0 ? (
          <Skeleton variant="row" count={2} />
        ) : capabilities.length === 0 ? (
          <EmptyState left>
            No capabilities loaded. Run <code>pnpm new-capability my-agent</code> to scaffold
            one, then rescan.
          </EmptyState>
        ) : (
          <div className="agents">
            {capabilities.map((capability) => {
              const degraded = capability.types?.filter((type) => type.degraded_reason) ?? [];
              return (
                <div className={degraded.length ? "agent err" : "agent"} key={capability.id}>
                  <div className="top">
                    <StatusDot
                      state={!capability.enabled ? "idle" : degraded.length ? "err" : "ok"}
                      label={
                        !capability.enabled
                          ? "disabled"
                          : degraded.length
                            ? "degraded"
                            : "connected"
                      }
                    />
                    <b>{capability.name}</b>
                  </div>
                  <div className="meta">
                    v{capability.version} · owner {capability.owner}
                    <br />
                    needs: {capability.requires_capabilities.join(", ") || "nothing"}
                  </div>
                  <div className="item-badges">
                    {(capability.types ?? []).map((type) => (
                      <Badge
                        key={type.type}
                        spec={{
                          label: `${type.type}: ${MODE_LABEL[type.effective_mode]}`,
                          variant: MODE_VARIANT[type.effective_mode],
                          ...(type.degraded_reason ? { title: type.degraded_reason } : {}),
                        }}
                      />
                    ))}
                  </div>
                  {degraded.length > 0 ? (
                    <div className="meta" style={{ marginTop: 6 }}>
                      {degraded[0]?.degraded_reason}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {problems.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            {problems.map((problem, i) => (
              <ErrorStrip
                key={i}
                message={`${problem.capabilityId ?? problem.dir}: ${problem.message}`}
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="card" id="routing">
        <h2>Routing and defaults</h2>

        {routing.loading && !routing.data ? (
          <SkeletonRows count={4} />
        ) : routing.error ? (
          <ErrorBanner error={routing.error} onRetry={routing.reload} />
        ) : (
          <>
            {routingError ? <ErrorStrip message={routingError} /> : null}
            <div style={{ overflowX: "auto" }}>
              <table className="rtable">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Default app</th>
                    <th>Account / target</th>
                    <th>Default mode</th>
                  </tr>
                </thead>
                <tbody>
                  {(routing.data ?? []).map((entry) => (
                    <tr key={entry.action_type}>
                      <td>
                        <code>{entry.action_type}</code>
                      </td>
                      <td>
                        {entry.provider}
                        {entry.fallback_provider ? (
                          <span className="locked"> (falls back to {entry.fallback_provider})</span>
                        ) : null}
                      </td>
                      <td>{entry.account}</td>
                      <td>
                        {entry.locked ? (
                          <>
                            <Badge
                              spec={{
                                label: MODE_LABEL[entry.mode],
                                variant: MODE_VARIANT[entry.mode],
                              }}
                            />{" "}
                            <span className="locked">locked by policy</span>
                          </>
                        ) : (
                          <select
                            value={entry.mode}
                            disabled={savingType === entry.action_type}
                            aria-label={`Default mode for ${entry.action_type}`}
                            onChange={(event) =>
                              void changeMode(entry, event.target.value as ExecutionMode)
                            }
                          >
                            {MODES.map((mode) => (
                              <option key={mode} value={mode}>
                                {MODE_LABEL[mode]}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="footnote">
              Money never moves automatically. <code>payment.make</code> is locked to Guided by
              policy, whatever is connected, and the API refuses to change it.
            </div>
          </>
        )}
      </div>
    </>
  );
}
