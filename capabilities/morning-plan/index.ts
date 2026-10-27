import type { RunContext, RunResult } from "../../src/run-layer/context.js";
import type { DraftActionItem } from "../../src/types/index.js";

interface MorningMeeting {
  title: string;
  starts_at: string;
}

interface MorningTask {
  title: string;
  due?: string;
  list?: string;
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const triggerPayload = (ctx.trigger.payload ?? {}) as Record<string, unknown>;
  const eventType =
    (typeof ctx.inputs.event_type === "string" && ctx.inputs.event_type) ||
    (typeof triggerPayload.event_type === "string" && triggerPayload.event_type) ||
    "";
  const isOfficeArrived =
    eventType === "location.office_arrived" || ctx.inputs.office_arrived === true;
  const isWorkoutCompleted =
    eventType === "workout.completed" || typeof triggerPayload.workout_title === "string";

  const today =
    (typeof ctx.inputs.date === "string" && ctx.inputs.date) ||
    new Date().toLocaleDateString("sv-SE");
  const meetings = Array.isArray(ctx.inputs.meetings)
    ? (ctx.inputs.meetings as MorningMeeting[])
    : [];
  const openTasks = Array.isArray(ctx.inputs.open_tasks)
    ? (ctx.inputs.open_tasks as MorningTask[])
    : [];
  const undatedTasks = Array.isArray(ctx.inputs.undated_tasks)
    ? (ctx.inputs.undated_tasks as MorningTask[])
    : [];
  const workoutSummary =
    typeof triggerPayload.workout_title === "string"
      ? `Workout completed: ${triggerPayload.workout_title}. `
      : "";
  const readiness =
    typeof ctx.inputs.readiness_note === "string" && ctx.inputs.readiness_note
      ? `${workoutSummary}${ctx.inputs.readiness_note}`
      : `${workoutSummary}Readiness normal; focus blocks open.`;

  const firstHourTasks = openTasks.slice(0, 5);
  const lines = [
    isOfficeArrived
      ? `## First-Hour Office Focus (${today})`
      : isWorkoutCompleted
        ? `## Post-Workout Morning Plan (${today})`
        : `## Morning Plan (${today})`,
    "",
    `- **Readiness**: ${readiness}`,
    ...(isOfficeArrived
      ? [
          `- **First-Hour Focus Queue (Top ${firstHourTasks.length})**:`,
          ...(firstHourTasks.length
            ? firstHourTasks.map(
                (t, idx) => `  ${idx + 1}. ${t.title}${t.due ? ` (due ${t.due})` : ""}`,
              )
            : ["  - Inbox zero; pick top architectural milestone"]),
        ]
      : []),
    `- **Meetings Today (${meetings.length})**:`,
    ...(meetings.length
      ? meetings.map((m) => `  - ${m.starts_at}: ${m.title}`)
      : ["  - Clear calendar"]),
    `- **Top Tasks (${openTasks.length})**:`,
    ...(openTasks.length
      ? openTasks.map((t) => `  - ${t.title}${t.due ? ` (due ${t.due})` : ""}`)
      : ["  - No dated tasks due today"]),
  ];

  const headlinePrefix = isOfficeArrived
    ? `First-Hour Focus for ${today}`
    : isWorkoutCompleted
      ? `Post-Workout Plan for ${today}`
      : `Morning Plan for ${today}`;

  const items: DraftActionItem[] = [
    {
      capability_id: "morning-plan",
      type: "morning-plan-brief",
      context: {
        what_happened: `Generated ${isOfficeArrived ? "first-hour office focus" : "morning plan"} for ${today} (${meetings.length} meetings, ${openTasks.length} dated tasks)`,
        source: { kind: "schedule", id: `morning-plan:${today}` },
        provenance: [
          "google.calendar",
          "ticktick",
          "oura",
          ...(isOfficeArrived ? ["location.office_arrived"] : []),
          ...(isWorkoutCompleted ? ["workout.completed"] : []),
        ],
        why_flagged: isOfficeArrived ? "office arrival first-hour focus briefing" : "daily morning briefing",
        trigger_reason: "policy",
        confidence: 0.92,
        decision_needed: `Append ${today} morning plan to daily note?`,
        decision_surface: "inbox",
        execution_surface: "obsidian",
        outcome_preview: `Appends morning plan section to Daily/${today}.md`,
      },
      custom: {
        headline: `${headlinePrefix}: ${meetings.length} meeting(s), ${openTasks.length} priority task(s)`,
        date: today,
        path: `Daily/${today}.md`,
        content: lines.join("\n"),
      },
      dedupe_key: isOfficeArrived ? `morning-plan:office:${today}` : `morning-plan:${today}`,
    },
  ];

  for (const undated of undatedTasks.slice(0, 3)) {
    items.push({
      capability_id: "morning-plan",
      type: "backlog-date-nudge",
      context: {
        what_happened: `Undated TickTick backlog item "${undated.title}" has no scheduled date`,
        source: { kind: "ticktick", id: `undated:${undated.title}` },
        provenance: ["ticktick.backlog"],
        why_flagged: "undated backlog items need a date assignment or explicit deferral",
        trigger_reason: "policy",
        confidence: 0.85,
        decision_needed: `Schedule "${undated.title}" for ${today}?`,
        decision_surface: "inbox",
        execution_surface: "ticktick",
        outcome_preview: `Assigns due date ${today} to "${undated.title}" in TickTick`,
      },
      custom: {
        title: undated.title,
        content: `Scheduled from Morning Plan backlog nudge on ${today}`,
        due: today,
        list: undated.list ?? "work-list",
        suggested_slot: `${today} afternoon focus block`,
      },
      dedupe_key: `morning-plan:undated:${today}:${undated.title}`,
    });
  }

  return { action_items: items, status: "ok", logs: [] };
}
