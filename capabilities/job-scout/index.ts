import type { RunContext, RunResult } from "../../src/run-layer/context.js";
import type { DraftActionItem } from "../../src/types/index.js";

interface JobPosting {
  id?: string;
  company: string;
  role_title: string;
  fit_score?: number;
  summary?: string;
  url?: string;
}

interface RecruiterMessage {
  id?: string;
  from: string;
  company: string;
  subject: string;
  snippet?: string;
}

interface InterviewSlot {
  company: string;
  role_title: string;
  interviewer?: string;
  starts_at: string;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const postings = Array.isArray(ctx.inputs.job_postings)
    ? (ctx.inputs.job_postings as JobPosting[])
    : [];
  const messages = Array.isArray(ctx.inputs.recruiter_messages)
    ? (ctx.inputs.recruiter_messages as RecruiterMessage[])
    : [];
  const interviews = Array.isArray(ctx.inputs.upcoming_interviews)
    ? (ctx.inputs.upcoming_interviews as InterviewSlot[])
    : [];

  const items: DraftActionItem[] = [];

  for (const job of postings) {
    const score = typeof job.fit_score === "number" ? job.fit_score : 88;
    const summary =
      job.summary ??
      `Strong alignment on AI platform / PM leadership at ${job.company} (fit score ${score}/100).`;
    const path = `Career/Pipeline/${slug(job.company)}-${slug(job.role_title)}.md`;
    items.push({
      capability_id: "job-scout",
      type: "job-match-review",
      scope: "personal",
      context: {
        what_happened: `Matched role "${job.role_title}" at ${job.company} (fit ${score}/100)`,
        source: { kind: "job-scout", id: job.id ?? `${job.company}:${job.role_title}`, ...(job.url ? { url: job.url } : {}) },
        provenance: ["job-scout.matcher"],
        why_flagged: "high-fit leadership role matching target criteria",
        trigger_reason: "policy",
        confidence: 0.88,
        decision_needed: `Save ${job.company} - ${job.role_title} to career pipeline?`,
        decision_surface: "inbox",
        execution_surface: "obsidian",
        outcome_preview: `Creates pipeline dossier at ${path}`,
      },
      custom: {
        company: job.company,
        role_title: job.role_title,
        fit_score: score,
        match_summary: summary,
        path,
        content: `# ${job.company} - ${job.role_title}\n\n- **Fit Score**: ${score}/100\n- **Summary**: ${summary}\n${job.url ? `- **URL**: ${job.url}\n` : ""}`,
      },
      dedupe_key: `job-scout:match:${slug(job.company)}:${slug(job.role_title)}`,
    });
  }

  for (const msg of messages) {
    const draftBody = [
      `Hi,`,
      "",
      `Thanks for reaching out regarding ${msg.company}. I would be glad to learn more about the scope and team priorities. Feel free to share a few times that work this week.`,
      "",
      "Best,",
      "Sandip",
    ].join("\n");

    items.push({
      capability_id: "job-scout",
      type: "recruiter-reply-draft",
      scope: "personal",
      context: {
        what_happened: `Recruiter outreach from ${msg.from} (${msg.company}): "${msg.subject}"`,
        source: { kind: "gmail", id: msg.id ?? `recruiter:${msg.from}` },
        provenance: ["gmail.recruiter"],
        why_flagged: "recruiter outreach requires human review before staging Gmail reply draft",
        trigger_reason: "policy",
        confidence: 0.9,
        decision_needed: `Stage Gmail reply draft to ${msg.from} (${msg.company})?`,
        decision_surface: "inbox",
        execution_surface: "gmail",
        outcome_preview: `Creates a Gmail draft reply to ${msg.from} (never auto-sent)`,
      },
      custom: {
        from: msg.from,
        to: msg.from,
        company: msg.company,
        subject: msg.subject,
        draft_body: draftBody,
      },
      dedupe_key: `job-scout:recruiter:${msg.id ?? slug(msg.from + "-" + msg.subject)}`,
    });
  }

  for (const iv of interviews) {
    const path = `Career/Interviews/${slug(iv.company)}-${iv.starts_at.slice(0, 10)}.md`;
    const body = [
      `# Interview Prep: ${iv.company} (${iv.role_title})`,
      "",
      `- **Starts At**: ${iv.starts_at}`,
      `- **Interviewer**: ${iv.interviewer ?? "Hiring Panel"}`,
      "",
      "## Key Talking Points",
      "- Agentic OS architecture, local-first guardrails, and product velocity",
      "- Quantitative funnel & retention impact across B2C/B2B surfaces",
    ].join("\n");

    items.push({
      capability_id: "job-scout",
      type: "interview-prep-brief",
      scope: "personal",
      context: {
        what_happened: `Upcoming interview with ${iv.company} for ${iv.role_title} at ${iv.starts_at}`,
        source: { kind: "calendar", id: `interview:${iv.company}:${iv.starts_at}` },
        provenance: ["google.calendar", "recall"],
        why_flagged: "upcoming interview requires preparation brief",
        trigger_reason: "policy",
        confidence: 0.92,
        decision_needed: `Save interview prep brief for ${iv.company}?`,
        decision_surface: "inbox",
        execution_surface: "obsidian",
        outcome_preview: `Writes interview prep brief to ${path}`,
      },
      custom: {
        headline: `Interview Prep: ${iv.company} (${iv.role_title})`,
        company: iv.company,
        path,
        content: body,
      },
      dedupe_key: `job-scout:interview:${slug(iv.company)}:${iv.starts_at}`,
    });
  }

  return { action_items: items, status: "ok", logs: [] };
}
