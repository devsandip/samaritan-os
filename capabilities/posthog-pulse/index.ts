import { loadConfig } from "../../src/config/index.js";
import type { RunContext, RunResult } from "../../src/run-layer/context.js";
import { getSecret } from "../../src/secrets.js";
import type { DraftActionItem } from "../../src/types/index.js";

export interface MetricPoint {
  name: string;
  value: number | null | undefined;
  baseline_7d?: number | null;
  delta_pct?: number | null;
}

export interface AnomalyItem {
  metric: string;
  delta_pct: number | "data_missing";
  summary: string;
}

export async function fetchPosthogMetrics(options: {
  projectId?: string;
  token?: string;
  host?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<MetricPoint[]> {
  const cfg = loadConfig();
  const projectId = options.projectId ?? cfg.posthog.project_id;
  const token = options.token ?? getSecret(`posthog:${cfg.posthog.account}`);
  if (!projectId || !token) return [];

  const host = (options.host ?? "https://app.posthog.com").replace(/\/+$/, "");
  const fetchFn = options.fetchImpl ?? fetch;
  const response = await fetchFn(`${host}/api/projects/${encodeURIComponent(projectId)}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query:
          "SELECT event, count() AS total FROM events WHERE timestamp >= now() - INTERVAL 7 DAY GROUP BY event ORDER BY total DESC LIMIT 10",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`posthog API ${response.status}: ${response.statusText}`);
  }
  const data = (await response.json()) as {
    results?: [string, number | null, number | null][];
    metrics?: MetricPoint[];
  };
  if (Array.isArray(data.metrics)) return data.metrics;
  if (Array.isArray(data.results)) {
    return data.results.map(([name, val, baseline]) => ({
      name: String(name),
      value: typeof val === "number" ? val : null,
      ...(typeof baseline === "number" ? { baseline_7d: baseline } : {}),
    }));
  }
  return [];
}

export function evaluatePosthogMetrics(
  metrics: MetricPoint[],
  thresholdPct = 15,
): {
  formattedLines: string[];
  derivedAnomalies: AnomalyItem[];
  missingMetrics: string[];
} {
  const formattedLines: string[] = [];
  const derivedAnomalies: AnomalyItem[] = [];
  const missingMetrics: string[] = [];

  for (const m of metrics) {
    if (m.value === null || m.value === undefined || Number.isNaN(m.value)) {
      missingMetrics.push(m.name);
      formattedLines.push(`- **${m.name}**: data_missing (no telemetry received in window)`);
      derivedAnomalies.push({
        metric: m.name,
        delta_pct: "data_missing",
        summary: `Telemetry for "${m.name}" returned null/missing (reported as data_missing, not zero).`,
      });
      continue;
    }

    let delta = m.delta_pct;
    if (
      (delta === undefined || delta === null) &&
      typeof m.baseline_7d === "number" &&
      m.baseline_7d > 0
    ) {
      delta = Math.round(((m.value - m.baseline_7d) / m.baseline_7d) * 100);
    }
    const safeDelta = typeof delta === "number" ? delta : 0;
    formattedLines.push(
      `- **${m.name}**: ${m.value} (${safeDelta >= 0 ? "+" : ""}${safeDelta}% vs 7d avg)`,
    );

    if (Math.abs(safeDelta) >= thresholdPct) {
      derivedAnomalies.push({
        metric: m.name,
        delta_pct: safeDelta,
        summary: `${m.name} shifted ${safeDelta >= 0 ? "+" : ""}${safeDelta}% vs 7-day baseline (current: ${m.value}).`,
      });
    }
  }

  return { formattedLines, derivedAnomalies, missingMetrics };
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const today =
    (typeof ctx.inputs.date === "string" && ctx.inputs.date) ||
    new Date().toLocaleDateString("sv-SE");
  const project =
    (typeof ctx.inputs.project_name === "string" && ctx.inputs.project_name) || "wndr.ist";

  let metrics: MetricPoint[] = Array.isArray(ctx.inputs.metrics)
    ? (ctx.inputs.metrics as MetricPoint[])
    : [];
  const logs: string[] = [];

  if (
    metrics.length === 0 &&
    (loadConfig().posthog.enabled ||
      typeof ctx.inputs.posthog_project_id === "string" ||
      typeof ctx.inputs.posthog_token === "string")
  ) {
    try {
      metrics = await fetchPosthogMetrics({
        ...(typeof ctx.inputs.posthog_project_id === "string"
          ? { projectId: ctx.inputs.posthog_project_id }
          : {}),
        ...(typeof ctx.inputs.posthog_token === "string"
          ? { token: ctx.inputs.posthog_token }
          : {}),
      });
      logs.push(`fetched ${metrics.length} metric(s) from PostHog`);
    } catch (err) {
      logs.push(`posthog fetch failed: ${(err as Error).message}`);
    }
  }

  const evaluated = evaluatePosthogMetrics(metrics);
  const anomalies: AnomalyItem[] = Array.isArray(ctx.inputs.anomalies)
    ? (ctx.inputs.anomalies as AnomalyItem[])
    : evaluated.derivedAnomalies;

  const lines = [
    `## PostHog Pulse: ${project} (${today})`,
    "",
    ...evaluated.formattedLines,
    ...(anomalies.length
      ? [
          "",
          "### Anomalies Flagged",
          ...anomalies.map(
            (a) =>
              `- **${a.metric}** (${a.delta_pct === "data_missing" ? "data_missing" : `${a.delta_pct}%`}): ${a.summary}`,
          ),
        ]
      : ["", "- No statistically significant anomalies detected today."]),
  ];

  const items: DraftActionItem[] = [
    {
      capability_id: "posthog-pulse",
      type: "analytics-pulse-digest",
      context: {
        what_happened: `PostHog 7-day pulse for ${project} (${metrics.length} metrics, ${anomalies.length} anomaly alerts)`,
        source: { kind: "posthog", id: `posthog:${project}:${today}` },
        provenance: ["posthog.query"],
        why_flagged: "daily product analytics pulse",
        trigger_reason: "policy",
        confidence: 0.9,
        decision_needed: `Record ${project} analytics pulse for ${today}?`,
        decision_surface: "inbox",
        execution_surface: "obsidian",
        outcome_preview: `Appends PostHog pulse to Daily/${today}.md`,
      },
      custom: {
        headline: `${project} Pulse (${today}): ${anomalies.length} anomaly alert(s)`,
        project_name: project,
        date: today,
        path: `Daily/${today}.md`,
        content: lines.join("\n"),
      },
      dedupe_key: `posthog-pulse:digest:${project}:${today}`,
    },
  ];

  for (const anomaly of anomalies) {
    const deltaLabel =
      anomaly.delta_pct === "data_missing" ? "data_missing" : `${anomaly.delta_pct}%`;
    items.push({
      capability_id: "posthog-pulse",
      type: "anomaly-investigation-task",
      context: {
        what_happened: `Anomaly on ${project} metric "${anomaly.metric}" (${deltaLabel} vs 7d baseline)`,
        source: { kind: "posthog", id: `posthog:anomaly:${project}:${anomaly.metric}:${today}` },
        provenance: ["posthog.anomaly_detector"],
        why_flagged: "metric deviation exceeded 15% threshold over 7-day rolling baseline",
        trigger_reason: "policy",
        confidence: 0.89,
        decision_needed: `Create TickTick task to investigate ${anomaly.metric} (${deltaLabel})?`,
        decision_surface: "inbox",
        execution_surface: "ticktick",
        outcome_preview: `Creates high-priority TickTick task in work-list`,
      },
      custom: {
        title: `Investigate ${project} ${anomaly.metric} shift (${deltaLabel})`,
        content: anomaly.summary,
        metric_name: anomaly.metric,
        delta_pct: deltaLabel,
        due: today,
        list: "work-list",
      },
      dedupe_key: `posthog-pulse:anomaly:${project}:${anomaly.metric}:${today}`,
    });
  }

  return { action_items: items, status: "ok", logs };
}
