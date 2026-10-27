/**
 * Settings (UI-SPEC §5.5, Command Centre D2).
 *
 * Exposes:
 *  - Capabilities grid + `Rescan capabilities/`
 *  - Per-source rules (`source_rules`): Mute Telegram, Snooze 4h, Pause Capability
 *  - Routing and defaults table (`PUT /api/routing/:action_type` with `payment.make` lock)
 *  - Connector sync cursors (`sync_cursors` for Google Calendar and Gmail)
 */
import { useState } from "react";
import { ApiError, api } from "../api/client";
import type { CapabilityManifest, ExecutionMode, LoadProblem, RoutingEntry, SourceRule } from "../api/types";
import { Badge, Button, StatusDot } from "../components/primitives";
import { EmptyState, ErrorBanner, ErrorStrip, Skeleton, SkeletonRows } from "../components/states";
import { MODE_LABEL, relativeTime } from "../lib/format";
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
  const sourceRulesData = useAsync(() => api.sourceRules(), []);
  const connections = useAsync(() => api.connections(), []);
  const sysHealth = useAsync(() => api.systemHealth(), []);
  const [savingType, setSavingType] = useState<string | undefined>(undefined);
  const [savingSource, setSavingSource] = useState<string | undefined>(undefined);
  const [rescanning, setRescanning] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [routingError, setRoutingError] = useState<string | undefined>(undefined);

  const rulesBySource = new Map<string, SourceRule>(
    (sourceRulesData.data?.rules ?? []).map((r) => [r.source_id, r]),
  );
  const syncCursors = sourceRulesData.data?.sync_cursors ?? [];

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

  const updateRule = async (
    sourceId: string,
    patch: { muted?: boolean; snoozed_until?: string | null; paused?: boolean },
    description: string,
  ) => {
    setSavingSource(sourceId);
    try {
      await api.updateSourceRule(sourceId, patch);
      onToast(`${sourceId}: ${description}`);
      sourceRulesData.reload();
    } catch (err) {
      onToast(`Failed to update ${sourceId}: ${(err as Error).message}`, "err");
    } finally {
      setSavingSource(undefined);
    }
  };

  return (
    <>
      <h1 className="h-greet">Settings</h1>
      <p className="h-sub">
        What is plugged in, per-source notification &amp; run controls, and how much autonomy each
        action type has.
      </p>

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}

      <div className="card">
        <h2>
          Capabilities &amp; Per-Source Rules
          <button className="link" type="button" onClick={rescan} disabled={rescanning}>
            {rescanning ? "rescanning..." : "Rescan capabilities/"}
          </button>
        </h2>
        <p className="detail-text" style={{ marginTop: 0 }}>
          Muting or snoozing a source silences outbound Telegram notifications while the capability
          still runs and populates Inbox. Pausing stops the Run Layer from executing scheduled or
          event runs for that capability.
        </p>
        {loading && capabilities.length === 0 ? (
          <Skeleton variant="row" count={2} />
        ) : capabilities.length === 0 ? (
          <EmptyState left>
            No capabilities loaded. Run <code>pnpm new-capability my-agent</code> to scaffold one,
            then rescan.
          </EmptyState>
        ) : (
          <div className="agents">
            {capabilities.map((capability) => {
              const degraded = capability.types?.filter((type) => type.degraded_reason) ?? [];
              const rule = rulesBySource.get(capability.id);
              const isMuted = Boolean(rule?.muted);
              const isPaused = Boolean(rule?.paused);
              const isSnoozed = Boolean(
                rule?.snoozed_until && Date.parse(rule.snoozed_until) > Date.now(),
              );
              const busy = savingSource === capability.id;

              return (
                <div className={degraded.length ? "agent err" : "agent"} key={capability.id}>
                  <div className="top">
                    <StatusDot
                      state={
                        !capability.enabled || isPaused
                          ? "idle"
                          : degraded.length
                            ? "err"
                            : "ok"
                      }
                      label={
                        !capability.enabled
                          ? "disabled"
                          : isPaused
                            ? "paused"
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

                  <div
                    style={{
                      display: "flex",
                      gap: 5,
                      flexWrap: "wrap",
                      marginTop: 10,
                      paddingTop: 8,
                      borderTop: "1px dashed var(--line)",
                    }}
                  >
                    <Button
                      small
                      variant={isMuted ? "primary" : "default"}
                      disabled={busy}
                      onClick={() =>
                        void updateRule(
                          capability.id,
                          { muted: !isMuted },
                          isMuted ? "Telegram unmuted" : "Telegram muted",
                        )
                      }
                    >
                      {isMuted ? "Muted" : "Mute Telegram"}
                    </Button>
                    <Button
                      small
                      variant={isSnoozed ? "primary" : "default"}
                      disabled={busy}
                      onClick={() => {
                        const nextSnooze = isSnoozed
                          ? null
                          : new Date(Date.now() + 4 * 3600_000).toISOString();
                        void updateRule(
                          capability.id,
                          { snoozed_until: nextSnooze },
                          isSnoozed ? "Snooze cleared" : "Snoozed for 4h",
                        );
                      }}
                    >
                      {isSnoozed ? "Snoozed (Clear)" : "Snooze 4h"}
                    </Button>
                    <Button
                      small
                      variant={isPaused ? "primary" : "default"}
                      disabled={busy}
                      onClick={() =>
                        void updateRule(
                          capability.id,
                          { paused: !isPaused },
                          isPaused ? "Runs resumed" : "Runs paused",
                        )
                      }
                    >
                      {isPaused ? "Paused (Resume)" : "Pause Runs"}
                    </Button>
                  </div>
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

      <div className="card">
        <h2>
          Connections &amp; Credentials
          <button className="link" type="button" onClick={connections.reload}>
            Refresh
          </button>
        </h2>
        <p className="detail-text" style={{ marginTop: 0 }}>
          Live Keychain credential status and sync state across external services.
        </p>
        {connections.loading && !connections.data ? (
          <SkeletonRows count={3} />
        ) : (
          <div className="agents">
            {(connections.data ?? []).map((conn) => (
              <div
                className={conn.status === "error" ? "agent err" : "agent"}
                key={conn.id}
              >
                <div className="top">
                  <StatusDot
                    state={
                      conn.status === "connected"
                        ? "ok"
                        : conn.status === "error"
                          ? "err"
                          : "idle"
                    }
                    label={conn.status}
                  />
                  <b>{conn.name}</b>
                </div>
                <div className="meta">
                  provider: <code>{conn.provider}</code> · key:{" "}
                  <code>{conn.keychain_account}</code>
                  {conn.last_sync_at ? (
                    <>
                      <br />
                      last sync: {relativeTime(conn.last_sync_at)}
                    </>
                  ) : null}
                  {conn.last_error ? (
                    <div style={{ color: "var(--danger)", marginTop: 4 }}>
                      {conn.last_error}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>
          Connector Sync Cursors</h2>
        {syncCursors.length === 0 ? (
          <div className="detail-text" style={{ color: "var(--muted)" }}>
            No incremental sync cursors recorded yet (Google Calendar and Gmail pollers record
            their <code>syncToken</code> / <code>historyId</code> here).
          </div>
        ) : (
          <table className="rtable">
            <thead>
              <tr>
                <th>Connector Source</th>
                <th>Cursor</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {syncCursors.map((c) => (
                <tr key={c.source}>
                  <td>
                    <code>{c.source}</code>
                  </td>
                  <td>
                    <code>{(c.cursor ?? "none").slice(0, 32)}</code>
                  </td>
                  <td>{c.last_success_at ? relativeTime(c.last_success_at) : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>
          System Health, Backups &amp; Billing Guardrails
          <button
            className="link"
            type="button"
            disabled={backingUp}
            onClick={async () => {
              setBackingUp(true);
              try {
                const res = await api.triggerBackup();
                onToast(
                  `Backup verified (${Math.round(res.backup.size_bytes / 1024)} KB)`,
                );
                sysHealth.reload();
              } catch (err) {
                onToast(`Backup failed: ${(err as Error).message}`, "err");
              } finally {
                setBackingUp(false);
              }
            }}
          >
            {backingUp ? "backing up..." : "Run SQLite Backup Now"}
          </button>
        </h2>
        {sysHealth.data ? (
          <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
            <div>
              <b>SQLite PRAGMA integrity_check:</b>{" "}
              <code>{sysHealth.data.sqlite_integrity}</code>
            </div>
            <div>
              <b>Keychain Access:</b>{" "}
              <code>{sysHealth.data.keychain.accessible ? "ok" : "unavailable"}</code> (
              {sysHealth.data.keychain.detail})
            </div>
            <div>
              <b>Monthly LLM Spend (C2 Guardrail):</b> $
              {sysHealth.data.billing.mtd_spend_usd.toFixed(2)} / $
              {sysHealth.data.billing.monthly_cap_usd.toFixed(2)} cap ($
              {sysHealth.data.billing.remaining_usd.toFixed(2)} remaining)
            </div>
            <div>
              <b>Verified Backups:</b> {sysHealth.data.backups.length} snapshot(s) in{" "}
              <code>db_backups</code>
              {sysHealth.data.backups[0]
                ? ` (latest: ${relativeTime(sysHealth.data.backups[0].created_at)})`
                : ""}
            </div>
          </div>
        ) : (
          <div className="detail-text">Loading system diagnostics...</div>
        )}
      </div>
    </>
  );
}
