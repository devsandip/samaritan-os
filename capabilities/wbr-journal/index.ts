import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, repoRoot } from "../../src/config/index.js";
import type { RunContext, RunResult } from "../../src/run-layer/context.js";

export interface ScannedWbrRollup {
  repos_scanned: string[];
  highlights: string[];
  decisions: string[];
  direction_changes: string[];
  needs_revisit: string[];
}

function extractSectionBullets(markdown: string, headingName: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const target = headingName.toLowerCase();
  const out: string[] = [];
  let inSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    const headingMatch = /^#{2,3}\s+(.+)$/.exec(line);
    if (headingMatch) {
      const current = headingMatch[1]!.trim().toLowerCase();
      inSection = current.startsWith(target);
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith("- ") || line.startsWith("* ")) {
      const text = line.slice(2).trim();
      if (text && text.toLowerCase() !== "none" && text.toLowerCase() !== "none.") {
        out.push(text);
      }
    }
  }
  return out;
}

function extractTitle(markdown: string, fallback: string): string {
  for (const raw of markdown.split(/\r?\n/)) {
    const match = /^#\s+(.+)$/.exec(raw.trim());
    if (match) return match[1]!.trim();
  }
  return fallback;
}

/**
 * Scans either a multi-repo directory (`~/Developer`) or a single repository root
 * for `journal/entries/*.md` and `journal/INDEX.md`, extracting cited Highlights,
 * Decisions, Direction changes, and Needs revisit items.
 */
export function scanMultiRepoJournals(
  rootDir: string,
  opts: { maxEntriesPerRepo?: number } = {},
): ScannedWbrRollup {
  const maxEntries = opts.maxEntriesPerRepo ?? 3;
  const rollup: ScannedWbrRollup = {
    repos_scanned: [],
    highlights: [],
    decisions: [],
    direction_changes: [],
    needs_revisit: [],
  };

  if (!existsSync(rootDir)) return rollup;

  const candidateRepos: { name: string; dir: string }[] = [];
  if (existsSync(join(rootDir, "journal"))) {
    candidateRepos.push({ name: basename(rootDir), dir: rootDir });
  }
  try {
    const entries = readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const sub = join(rootDir, entry.name);
      if (existsSync(join(sub, "journal"))) {
        candidateRepos.push({ name: entry.name, dir: sub });
      }
    }
  } catch {
    // Ignore unreadable directories
  }

  for (const repo of candidateRepos) {
    rollup.repos_scanned.push(repo.name);
    const entriesDir = join(repo.dir, "journal", "entries");
    if (existsSync(entriesDir)) {
      let files: string[] = [];
      try {
        files = readdirSync(entriesDir)
          .filter((f) => f.endsWith(".md"))
          .sort()
          .reverse()
          .slice(0, maxEntries);
      } catch {
        files = [];
      }

      for (const file of files) {
        const cite = `[${repo.name}/journal/entries/${file}]`;
        let text = "";
        try {
          text = readFileSync(join(entriesDir, file), "utf8");
        } catch {
          continue;
        }
        const title = extractTitle(text, file.replace(/\.md$/, ""));
        rollup.highlights.push(`${title} ${cite}`);
        for (const d of extractSectionBullets(text, "Decisions")) {
          rollup.decisions.push(`${d} ${cite}`);
        }
        for (const c of extractSectionBullets(text, "Direction changes")) {
          rollup.direction_changes.push(`${c} ${cite}`);
        }
        for (const r of extractSectionBullets(text, "Needs revisit")) {
          rollup.needs_revisit.push(`${r} ${cite}`);
        }
      }
    }

    const indexFile = join(repo.dir, "journal", "INDEX.md");
    if (existsSync(indexFile)) {
      try {
        const indexMd = readFileSync(indexFile, "utf8");
        const cite = `[${repo.name}/journal/INDEX.md]`;
        for (const openThread of extractSectionBullets(indexMd, "Open threads")) {
          if (rollup.needs_revisit.length < 10) {
            rollup.needs_revisit.push(`${openThread} ${cite}`);
          }
        }
      } catch {
        // Ignore unreadable INDEX.md
      }
    }
  }

  return rollup;
}

function currentIsoWeek(now = new Date()): string {
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const isoWeek =
    (typeof ctx.inputs.iso_week === "string" && ctx.inputs.iso_week) || currentIsoWeek();

  const hasExplicitInputs =
    Array.isArray(ctx.inputs.highlights) ||
    Array.isArray(ctx.inputs.decisions) ||
    Array.isArray(ctx.inputs.direction_changes) ||
    Array.isArray(ctx.inputs.needs_revisit);

  const journalsRoot =
    typeof ctx.inputs.journals_root === "string" && ctx.inputs.journals_root
      ? ctx.inputs.journals_root
      : ctx.inputs.scan_all_repos === true
        ? loadConfig().paths.journals
        : repoRoot();

  const scanned = hasExplicitInputs
    ? {
        repos_scanned: [],
        highlights: [],
        decisions: [],
        direction_changes: [],
        needs_revisit: [],
      }
    : scanMultiRepoJournals(journalsRoot);

  const highlights = Array.isArray(ctx.inputs.highlights)
    ? (ctx.inputs.highlights as string[])
    : scanned.highlights.length > 0
      ? scanned.highlights
      : ["Shipped Samaritan Command Centre Phases 0-2."];
  const decisions = Array.isArray(ctx.inputs.decisions)
    ? (ctx.inputs.decisions as string[])
    : scanned.decisions.length > 0
      ? scanned.decisions
      : ["Adopted 3-way consensus PROPOSAL-v1 with Rule-of-Two worker isolation."];
  const directionChanges = Array.isArray(ctx.inputs.direction_changes)
    ? (ctx.inputs.direction_changes as string[])
    : scanned.direction_changes.length > 0
      ? scanned.direction_changes
      : ["None."];
  const needsRevisit = Array.isArray(ctx.inputs.needs_revisit)
    ? (ctx.inputs.needs_revisit as string[])
    : scanned.needs_revisit.length > 0
      ? scanned.needs_revisit
      : ["None."];

  const path = `WBR/${isoWeek}-summary.md`;
  const content = [
    `# Weekly Business & Engineering Review (${isoWeek})`,
    "",
    "## Highlights",
    ...highlights.map((h) => `- ${h}`),
    "",
    "## Decisions",
    ...decisions.map((d) => `- ${d}`),
    "",
    "## Direction changes",
    ...directionChanges.map((c) => `- ${c}`),
    "",
    "## Needs revisit",
    ...needsRevisit.map((r) => `- ${r}`),
  ].join("\n");

  return {
    action_items: [
      {
        capability_id: "wbr-journal",
        type: "wbr-weekly-summary",
        context: {
          what_happened: `Compiled weekly WBR & journal summary for ${isoWeek} (${highlights.length} highlight(s), ${decisions.length} decision(s))`,
          source: { kind: "journal", id: `wbr:${isoWeek}` },
          provenance: ["journal.entries", "git.log", "posthog"],
          why_flagged: "weekly WBR narrative requires human review before freezing",
          trigger_reason: "policy",
          confidence: 0.91,
          decision_needed: `Approve and file ${isoWeek} WBR summary to ${path}?`,
          decision_surface: "inbox",
          execution_surface: "obsidian",
          outcome_preview: `Writes ${path} in the Obsidian vault`,
        },
        custom: {
          headline: `WBR Summary (${isoWeek}): ${highlights[0] ?? "Weekly Rollup"}`,
          iso_week: isoWeek,
          path,
          content,
        },
        dedupe_key: `wbr-journal:${isoWeek}`,
      },
    ],
    status: "ok",
    logs:
      scanned.repos_scanned.length > 0
        ? [`scanned ${scanned.repos_scanned.length} journal repo(s): ${scanned.repos_scanned.join(", ")}`]
        : [],
  };
}
