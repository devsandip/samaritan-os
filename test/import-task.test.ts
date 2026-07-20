/**
 * Importing a Claude scheduled task (TECH-SPEC §8).
 *
 * A scheduled task is a prompt plus a cadence, and the prompt is the whole
 * asset. So the assertions that matter are: the prompt survives verbatim, what
 * comes out loads and runs, and the thing it produces goes through the review
 * gate rather than around it.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { repoRoot } from "../src/config/index.js";
import { runCapability } from "../src/run-layer/index.js";

const roots: string[] = [];
const apps: App[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TASK = `Every morning at 7am, check my calendar and my open PRs.

Tell me any meeting where I am the organiser but have not sent an agenda, and
any PR of mine open more than 3 days with no review.

Be terse. If everything is fine, say nothing.`;

function freshDir(): string {
  const root = mkdtempSync(join(tmpdir(), "samaritan-import-"));
  roots.push(root);
  // The generated entrypoint imports @anthropic-ai/sdk. Node resolves bare
  // specifiers by walking up from the file, which finds the repo's
  // node_modules for a capability living in capabilities/ and finds nothing
  // for one in a temp dir. Symlinking keeps the test isolated from the repo's
  // real capabilities folder without changing how resolution works.
  symlinkSync(join(repoRoot(), "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

/** Runs the CLI for real, feeding the task on stdin. */
function importTask(args: string[], dir: string, task = TASK): string {
  const taskFile = join(dir, "task.md");
  writeFileSync(taskFile, task);
  return execFileSync(
    join(repoRoot(), "node_modules", ".bin", "tsx"),
    [join(repoRoot(), "src", "cli", "import-task.ts"), ...args, "--file", taskFile, "--dir", dir],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function appFor(dir: string): App {
  const app = createApp({ dbPath: ":memory:", capabilitiesDir: dir });
  apps.push(app);
  return app;
}

describe("what it writes", () => {
  it("writes the prompt, a manifest and an entrypoint", () => {
    const dir = freshDir();
    const output = importTask(["--id", "morning-brief", "--cron", "0 7 * * *"], dir);

    for (const file of ["instructions.md", "manifest.yaml", "index.ts"]) {
      expect(existsSync(join(dir, "morning-brief", file))).toBe(true);
    }
    expect(output).toMatch(/pnpm run-capability morning-brief/);
  });

  it("keeps the prompt verbatim", () => {
    // The prompt is the asset being imported. Reformatting it, summarising it,
    // or folding it into a template would change what the agent does.
    const dir = freshDir();
    importTask(["--id", "verbatim"], dir);
    expect(readFileSync(join(dir, "verbatim", "instructions.md"), "utf8").trim()).toBe(TASK);
  });

  it("reads the prompt at run time rather than baking it in", () => {
    const dir = freshDir();
    importTask(["--id", "reader"], dir);

    const entrypoint = readFileSync(join(dir, "reader", "index.ts"), "utf8");
    expect(entrypoint).toContain("instructions.md");
    // Editing what the agent does must not mean editing code.
    expect(entrypoint).not.toContain("check my calendar");
  });

  it("carries the cron across", () => {
    const dir = freshDir();
    importTask(["--id", "timed", "--cron", "0 7 * * *"], dir);
    expect(readFileSync(join(dir, "timed", "manifest.yaml"), "utf8")).toContain('cron: "0 7 * * *"');
  });

  it("falls back to a manual trigger when no cron is given", () => {
    const dir = freshDir();
    importTask(["--id", "on-demand"], dir);
    const manifest = readFileSync(join(dir, "on-demand", "manifest.yaml"), "utf8");
    expect(manifest).toContain("mode: manual");
    expect(manifest).toContain("command: /on-demand");
  });

  it("describes the capability from the task's own first line", () => {
    const dir = freshDir();
    importTask(["--id", "described"], dir);
    expect(readFileSync(join(dir, "described", "manifest.yaml"), "utf8")).toContain(
      "Every morning at 7am",
    );
  });

  it("takes a custom output shape", () => {
    const dir = freshDir();
    importTask(["--id", "shaped", "--attributes", "headline,risk,owner"], dir);

    const manifest = readFileSync(join(dir, "shaped", "manifest.yaml"), "utf8");
    expect(manifest).toContain("headline: string");
    expect(manifest).toContain("risk: string");
    expect(manifest).toContain("primary: headline");

    // The tool schema and the manifest have to agree or every item is rejected
    // at ingest, so they are generated from the same list.
    const entrypoint = readFileSync(join(dir, "shaped", "index.ts"), "utf8");
    expect(entrypoint).toContain('"headline","risk","owner"');
  });
});

describe("what it refuses", () => {
  const fails = (args: string[], dir: string, task = TASK): string => {
    try {
      importTask(args, dir, task);
      throw new Error("expected the CLI to exit non-zero");
    } catch (err) {
      return String((err as { stderr?: string }).stderr ?? (err as Error).message);
    }
  };

  it("insists on an id", () => {
    expect(fails([], freshDir())).toMatch(/--id is required/);
  });

  it("rejects an id that is not kebab-case", () => {
    expect(fails(["--id", "Morning Brief"], freshDir())).toMatch(/kebab-case/);
  });

  it("refuses an empty prompt", () => {
    expect(fails(["--id", "empty"], freshDir(), "   ")).toMatch(/No instructions/);
  });

  it("refuses to overwrite an existing capability", () => {
    const dir = freshDir();
    importTask(["--id", "twice"], dir);
    expect(fails(["--id", "twice"], dir)).toMatch(/already exists/);
  });

  it("rejects attribute names a manifest cannot carry", () => {
    expect(fails(["--id", "bad", "--attributes", "Not Valid"], freshDir())).toMatch(
      /lower_snake_case/,
    );
  });
});

describe("the imported agent", () => {
  it("loads into the registry with no problems", () => {
    const dir = freshDir();
    importTask(["--id", "loadable", "--cron", "0 7 * * *"], dir);

    const app = appFor(dir);
    expect(app.capabilities.problems()).toEqual([]);
    expect(app.capabilities.get("loadable")?.manifest.name).toBe("Loadable");
  });

  it("escalates everything, having earned nothing yet", () => {
    const dir = freshDir();
    importTask(["--id", "cautious"], dir);

    const type = appFor(dir).capabilities.getType("cautious", "cautious-review")!;
    // An imported task has no track record through the review gate, so there is
    // nothing yet to justify letting any of it through unattended.
    expect(type.spec.policy?.escalate_when).toBe("true");
    expect(type.spec.policy?.auto_complete_when).toBeUndefined();
    expect(type.effectiveMode).toBe("guided");
  });

  it("reports a missing API key instead of quietly emitting nothing", async () => {
    // A scheduled capability that silently stops producing items is
    // indistinguishable from a quiet week, which is the worst way to fail.
    const dir = freshDir();
    importTask(["--id", "keyless"], dir);

    const previous = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const report = await runCapability(appFor(dir), "keyless");
      expect(report.status).toBe("error");
      expect(report.logs.join(" ")).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      if (previous !== undefined) process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });
});

describe("the capabilities folder", () => {
  it("ignores a directory that never claimed to be a capability", () => {
    // node_modules is the case that surfaced this, but a scratch folder or a
    // half-created directory would each have raised a red banner saying a
    // capability failed to load. Nothing failed; nothing was there.
    const dir = freshDir();
    importTask(["--id", "real"], dir);
    mkdirSync(join(dir, "notes"), { recursive: true });

    const app = appFor(dir);
    expect(app.capabilities.problems()).toEqual([]);
    expect(app.capabilities.all().map((c) => c.manifest.id)).toEqual(["real"]);
  });

  it("still reports a manifest that exists and does not parse", () => {
    // The distinction worth keeping: silence for "no manifest", noise for
    // "a manifest I cannot read", which is what a filename typo looks like.
    const dir = freshDir();
    mkdirSync(join(dir, "broken"), { recursive: true });
    writeFileSync(join(dir, "broken", "manifest.yaml"), "id: broken\nname: [unclosed");

    expect(appFor(dir).capabilities.problems()).toHaveLength(1);
  });
});
