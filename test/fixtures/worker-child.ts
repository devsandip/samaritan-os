/**
 * A stand-in worker child that speaks `src/worker/protocol.ts` without a model.
 * The goal picks the script: "write" round-trips one tool call and finishes,
 * "hang" reports progress and then never finishes, so a test can stop it.
 */
type Msg = { type: string; [k: string]: unknown };

const pending = new Map<string, (m: Msg) => void>();
const send = (m: Msg) => process.send?.(m);

function tool(name: string, args: Record<string, unknown>): Promise<Msg> {
  const id = `call-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ type: "tool_call", id, name, args });
  });
}

process.on("message", async (m: Msg) => {
  if (m.type === "tool_result") {
    pending.get(m["id"] as string)?.(m);
    return;
  }
  if (m.type !== "start") return;
  const task = m["task"] as { goal: string };
  send({ type: "session", session_id: "fixture-session" });

  if (task.goal === "hang") {
    send({ type: "progress", text: "working on it" });
    setInterval(() => send({ type: "progress", text: "still working" }), 100);
    return;
  }

  const result = await tool("write_artifact", { filename: "out.md", content: "# from the child\n" });
  send({
    type: "done",
    status: result["ok"] ? "succeeded" : "failed",
    summary: String(result["value"] ?? result["error"]),
    cost_usd: 0.01,
    session_id: "fixture-session",
  });
  process.disconnect();
});
