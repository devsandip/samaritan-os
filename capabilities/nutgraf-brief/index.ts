import { loadConfig } from "../../src/config/index.js";
import type { RunContext, RunResult } from "../../src/run-layer/context.js";
import { getSecret } from "../../src/secrets.js";

export interface NutgrafArticle {
  title: string;
  source?: string;
  url?: string;
  nutgraf: string;
}

export interface NutgrafSummaryResponse {
  articles: NutgrafArticle[];
  audio_url?: string;
}

export async function fetchNutgrafSummary(options: {
  url?: string;
  token?: string;
  date?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<NutgrafSummaryResponse> {
  const cfg = loadConfig();
  const baseUrl = (options.url ?? cfg.nutgraf.url).replace(/\/+$/, "");
  const token = options.token ?? getSecret(`nutgraf:${cfg.nutgraf.account}`);
  if (!token) {
    return { articles: [] };
  }
  const fetchFn = options.fetchImpl ?? fetch;
  const query = options.date ? `?date=${encodeURIComponent(options.date)}` : "";
  const response = await fetchFn(`${baseUrl}/summary${query}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-nutgraf-machine-token": token,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`nutgraf API ${response.status}: ${response.statusText}`);
  }
  const body = (await response.json()) as {
    articles?: NutgrafArticle[];
    items?: NutgrafArticle[];
    audio_url?: string;
  };
  const articles = Array.isArray(body.articles)
    ? body.articles
    : Array.isArray(body.items)
      ? body.items
      : [];
  return {
    articles,
    ...(typeof body.audio_url === "string" && body.audio_url ? { audio_url: body.audio_url } : {}),
  };
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const today =
    (typeof ctx.inputs.date === "string" && ctx.inputs.date) ||
    new Date().toLocaleDateString("sv-SE");

  let articles: NutgrafArticle[] = Array.isArray(ctx.inputs.articles)
    ? (ctx.inputs.articles as NutgrafArticle[])
    : [];
  let audioUrl = typeof ctx.inputs.audio_url === "string" ? ctx.inputs.audio_url : undefined;
  const logs: string[] = [];

  if (
    articles.length === 0 &&
    (loadConfig().nutgraf.enabled ||
      typeof ctx.inputs.nutgraf_url === "string" ||
      typeof ctx.inputs.nutgraf_token === "string")
  ) {
    try {
      const fetched = await fetchNutgrafSummary({
        ...(typeof ctx.inputs.nutgraf_url === "string" ? { url: ctx.inputs.nutgraf_url } : {}),
        ...(typeof ctx.inputs.nutgraf_token === "string" ? { token: ctx.inputs.nutgraf_token } : {}),
        date: today,
      });
      articles = fetched.articles;
      audioUrl = audioUrl ?? fetched.audio_url;
      logs.push(`fetched ${articles.length} article(s) from Nutgraf API`);
    } catch (err) {
      logs.push(`nutgraf fetch failed: ${(err as Error).message}`);
    }
  }

  const deepLink = "https://sandip.dev/nutgraf/";
  const path = `Reading/Nutgraf-${today}.md`;
  const lines = [
    `# Nutgraf Reading Brief (${today})`,
    "",
    `- **Reader Link**: ${deepLink}`,
    ...(audioUrl ? [`- **Audio Briefing**: ${audioUrl}`] : []),
    "",
    ...(articles.length
      ? articles.flatMap((a) => [
          `## ${a.title}${a.source ? ` (${a.source})` : ""}`,
          a.nutgraf,
          ...(a.url ? [`- Link: ${a.url}`] : []),
          "",
        ])
      : ["No queued longform essays today."]),
  ];

  return {
    action_items: [
      {
        capability_id: "nutgraf-brief",
        type: "nutgraf-reading-digest",
        scope: "personal",
        context: {
          what_happened: `Synthesized ${articles.length} queued Nutgraf essay(s) for ${today}`,
          source: { kind: "nutgraf", id: `nutgraf:${today}`, url: audioUrl ?? deepLink },
          provenance: ["nutgraf.feed"],
          why_flagged: "evening reading synthesis",
          trigger_reason: "policy",
          confidence: 0.9,
          decision_needed: `Save ${today} Nutgraf reading brief to ${path}?`,
          decision_surface: "inbox",
          execution_surface: "obsidian",
          outcome_preview: `Writes ${path} in the Obsidian vault`,
        },
        custom: {
          headline: `Nutgraf Brief (${today}): ${articles.length} essay(s) distilled`,
          date: today,
          article_count: articles.length,
          path,
          content: lines.join("\n").trim(),
        },
        dedupe_key: `nutgraf-brief:${today}`,
      },
    ],
    status: "ok",
    logs,
  };
}
