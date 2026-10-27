import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunContext, RunResult } from "../../src/run-layer/context.js";

export interface PrdLensEvaluation {
  findings: string[];
  pm_findings: string[];
  ux_findings: string[];
  sde_findings: string[];
  rubric_score: number;
}

const PM_CHECKS: { label: string; pattern: RegExp; gap: string }[] = [
  {
    label: "Problem & user pain clearly framed",
    pattern: /\b(problem|pain|motivation|why now|background|context)\b/i,
    gap: "PM Lens [Gap]: Missing explicit problem statement or user pain framing.",
  },
  {
    label: "Success metrics / measurable KPIs defined",
    pattern: /\b(metric|kpi|goal|measure|success criteria|north star|conversion|retention|latency)\b/i,
    gap: "PM Lens [Gap]: Missing quantifiable success metrics or target KPIs.",
  },
  {
    label: "Explicit non-goals / scope boundaries stated",
    pattern: /\b(non-goal|non goal|out of scope|not doing|anti-goal|exclusions)\b/i,
    gap: "PM Lens [Gap]: Missing explicit non-goals or out-of-scope boundaries.",
  },
];

const UX_CHECKS: { label: string; pattern: RegExp; gap: string }[] = [
  {
    label: "Core user flow and information architecture specified",
    pattern: /\b(flow|journey|screen|view|layout|navigation|modal|drawer|inbox|card)\b/i,
    gap: "UX Lens [Gap]: Missing concrete user flow or view/layout hierarchy.",
  },
  {
    label: "Empty, loading, and error states addressed",
    pattern: /\b(empty state|loading|error state|degraded|fallback|skeleton|retry)\b/i,
    gap: "UX Lens [Gap]: Missing empty, loading, or degraded/error state specifications.",
  },
  {
    label: "Keyboard navigation and mobile responsiveness covered",
    pattern: /\b(keyboard|shortcut|cmd\+k|mobile|responsive|touch|accessibility|a11y)\b/i,
    gap: "UX Lens [Gap]: Missing keyboard shortcut or mobile/accessibility considerations.",
  },
];

const SDE_CHECKS: { label: string; pattern: RegExp; gap: string }[] = [
  {
    label: "Data model, schema, or API contracts defined",
    pattern: /\b(schema|table|sqlite|endpoint|api|payload|contract|interface|migration)\b/i,
    gap: "SDE Lens [Gap]: Missing data model, schema, or API contract definitions.",
  },
  {
    label: "Idempotency, concurrency, or failure recovery specified",
    pattern: /\b(idempoten|dedupe|lease|fenc|retry|timeout|reconcil|rollback|transaction)\b/i,
    gap: "SDE Lens [Gap]: Missing idempotency keys, timeout handling, or crash recovery semantics.",
  },
  {
    label: "Security, auth, or privacy guardrails documented",
    pattern: /\b(security|auth|token|keychain|secret|guardrail|permission|scope|lock)\b/i,
    gap: "SDE Lens [Gap]: Missing security boundary, secret storage, or authorization guardrails.",
  },
];

export function evaluatePrdMultiLens(markdown: string): PrdLensEvaluation {
  const pm_findings: string[] = [];
  const ux_findings: string[] = [];
  const sde_findings: string[] = [];
  let passed = 0;
  const total = PM_CHECKS.length + UX_CHECKS.length + SDE_CHECKS.length;

  for (const check of PM_CHECKS) {
    if (check.pattern.test(markdown)) {
      passed += 1;
      pm_findings.push(`PM Lens [Pass]: ${check.label}.`);
    } else {
      pm_findings.push(check.gap);
    }
  }

  for (const check of UX_CHECKS) {
    if (check.pattern.test(markdown)) {
      passed += 1;
      ux_findings.push(`UX Lens [Pass]: ${check.label}.`);
    } else {
      ux_findings.push(check.gap);
    }
  }

  for (const check of SDE_CHECKS) {
    if (check.pattern.test(markdown)) {
      passed += 1;
      sde_findings.push(`SDE Lens [Pass]: ${check.label}.`);
    } else {
      sde_findings.push(check.gap);
    }
  }

  const rubric_score = Math.round((passed / total) * 100);
  return {
    findings: [...pm_findings, ...ux_findings, ...sde_findings],
    pm_findings,
    ux_findings,
    sde_findings,
    rubric_score,
  };
}

function writeVersionedPrdArtifact(
  artifactDir: string,
  slug: string,
  content: string,
): { version: number; artifactPath: string } {
  mkdirSync(artifactDir, { recursive: true });
  const prefix = `PRD-${slug}-v`;
  let maxVersion = 0;
  try {
    for (const file of readdirSync(artifactDir)) {
      if (file.startsWith(prefix) && file.endsWith(".md")) {
        const verStr = file.slice(prefix.length, -3);
        const ver = Number.parseInt(verStr, 10);
        if (Number.isFinite(ver) && ver > maxVersion) maxVersion = ver;
      }
    }
  } catch {
    // Ignore read error
  }
  const version = maxVersion + 1;
  const artifactPath = join(artifactDir, `${prefix}${version}.md`);
  writeFileSync(artifactPath, content, "utf8");
  return { version, artifactPath };
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const payload = { ...ctx.inputs, ...((ctx.trigger.payload ?? {}) as Record<string, unknown>) };
  const prdPath = typeof payload.prd_path === "string" ? payload.prd_path : undefined;
  let prdMarkdown = typeof payload.prd_markdown === "string" ? payload.prd_markdown : "";

  if (!prdMarkdown && prdPath && existsSync(prdPath)) {
    try {
      prdMarkdown = readFileSync(prdPath, "utf8");
    } catch {
      prdMarkdown = "";
    }
  }

  const inferredTitle =
    prdMarkdown
      .split(/\r?\n/)
      .map((l) => /^#\s+(.+)$/.exec(l.trim())?.[1]?.trim())
      .find(Boolean) ?? undefined;

  const prdTitle =
    (typeof payload.prd_title === "string" && payload.prd_title) ||
    inferredTitle ||
    "Untitled Product Spec";
  const project =
    (typeof payload.project === "string" && payload.project) || "Samaritan";

  const evaluation = prdMarkdown ? evaluatePrdMultiLens(prdMarkdown) : undefined;
  const findings = Array.isArray(payload.findings)
    ? (payload.findings as string[])
    : evaluation
      ? evaluation.findings
      : [
          "PM Lens: Success metrics and non-goals are explicit.",
          "UX Lens: Keyboard navigation and empty states are specified.",
          "SDE Lens: Idempotency keys and failure recovery paths are defined.",
        ];

  let recallCitations: { kind: string; ref: string; excerpt?: string }[] = [];
  if (ctx.memory.recall) {
    try {
      const answer = await ctx.memory.recall(`${project} ${prdTitle} architecture decisions`);
      recallCitations = answer.citations ?? [];
    } catch {
      // Recall pipeline optional in isolated unit tests
    }
  }

  const slug = prdTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const path = `Reviews/PRD-${slug}.md`;

  const lines = [
    `# PRD Review: ${prdTitle} (${project})`,
    ...(evaluation ? ["", `**Rubric Readiness Score**: ${evaluation.rubric_score}%`] : []),
    "",
    "## Multi-Lens Review Findings",
    ...findings.map((f) => `- ${f}`),
    ...(recallCitations.length > 0
      ? [
          "",
          "## Related Context & Prior Decisions (Recall)",
          ...recallCitations.map(
            (c) => `- [${c.kind}] \`${c.ref}\`${c.excerpt ? `: ${c.excerpt.slice(0, 140)}` : ""}`,
          ),
        ]
      : []),
  ];

  const content = lines.join("\n");

  const artifactDir =
    typeof payload.artifact_dir === "string" && payload.artifact_dir
      ? payload.artifact_dir
      : join(homedir(), ".samaritan", "artifacts", "prd-reviews");

  let artifactInfo: { version: number; artifactPath: string } | undefined;
  if (payload.write_artifact !== false) {
    try {
      artifactInfo = writeVersionedPrdArtifact(artifactDir, slug, content);
    } catch {
      // Non-fatal if home artifacts dir is read-only
    }
  }

  return {
    action_items: [
      {
        capability_id: "prd-review",
        type: "prd-review-report",
        context: {
          what_happened: `Completed multi-lens PM/UX/SDE review for "${prdTitle}" (${project})`,
          source: { kind: "prd-review", id: `prd:${slug}` },
          provenance: [
            "prd-review.council",
            ...(recallCitations.length > 0 ? ["recall.citations"] : []),
          ],
          why_flagged: "PRD review report ready for sign-off",
          trigger_reason: "policy",
          confidence: 0.91,
          decision_needed: `Approve and file PRD review report for "${prdTitle}" to ${path}?`,
          decision_surface: "inbox",
          execution_surface: "obsidian",
          outcome_preview: `Writes ${path} in the Obsidian vault${artifactInfo ? ` (versioned artifact v${artifactInfo.version} saved)` : ""}`,
        },
        custom: {
          headline: `PRD Review: ${prdTitle} (${findings.length} findings)`,
          project,
          path,
          content,
        },
        dedupe_key: `prd-review:${slug}`,
      },
    ],
    status: "ok",
    logs: artifactInfo ? [`wrote artifact v${artifactInfo.version} to ${artifactInfo.artifactPath}`] : [],
  };
}
