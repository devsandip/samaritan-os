/**
 * The scaffolder (TECH-SPEC §8, "Template").
 *
 * The claim worth testing is not "it wrote two files" but "what it wrote
 * loads, validates and runs". A scaffold that produces an invalid manifest is
 * worse than no scaffold: the author's first experience of the platform is an
 * error in code they did not write.
 *
 * So these tests shell out to the real CLI and then put its output through the
 * real registry and the real Run Layer.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoRoot } from "../src/config/index.js";
import { runCapability } from "../src/run-layer/index.js";
import { harness } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Runs the CLI for real. Returns stdout; throws with stderr on a non-zero exit.
 *
 * Through tsx, not bare node: `src/` imports siblings with the `.js` extension
 * TypeScript's NodeNext resolution wants, and Node's type stripper does not
 * rewrite specifiers. That is why `package.json` runs every CLI under tsx in
 * dev and `dist/` in production. Capability entrypoints are the exception and
 * do load under bare node, because they import their siblings as `.ts`.
 */
function scaffold(args: string[], dir: string): string {
  return execFileSync(
    join(repoRoot(), "node_modules", ".bin", "tsx"),
    [join(repoRoot(), "src", "cli", "new-capability.ts"), ...args, "--dir", dir],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function freshDir(): string {
  const root = mkdtempSync(join(tmpdir(), "samaritan-scaffold-"));
  roots.push(root);
  return root;
}

describe("what it writes", () => {
  it("creates a manifest and an entrypoint", () => {
    const dir = freshDir();
    const output = scaffold(["my-agent"], dir);

    expect(existsSync(join(dir, "my-agent", "manifest.yaml"))).toBe(true);
    expect(existsSync(join(dir, "my-agent", "index.ts"))).toBe(true);
    expect(output).toMatch(/pnpm run-capability my-agent/);
  });

  it("translates the trigger flags into the manifest", () => {
    const dir = freshDir();
    scaffold(["nightly", "--mode", "scheduled", "--cron", "0 20 * * 0"], dir);

    const manifest = readFileSync(join(dir, "nightly", "manifest.yaml"), "utf8");
    expect(manifest).toContain("mode: scheduled");
    expect(manifest).toContain('cron: "0 20 * * 0"');
  });

  it("writes an event trigger with its subscriptions", () => {
    const dir = freshDir();
    scaffold(["triage", "--mode", "event", "--on", "email.received"], dir);

    const manifest = readFileSync(join(dir, "triage", "manifest.yaml"), "utf8");
    expect(manifest).toContain("mode: event");
    expect(manifest).toContain("on: [email.received]");
  });

  it("titles the capability from its id", () => {
    const dir = freshDir();
    scaffold(["newsletter-digest"], dir);
    expect(readFileSync(join(dir, "newsletter-digest", "manifest.yaml"), "utf8")).toContain(
      "name: Newsletter Digest",
    );
  });
});

describe("what it refuses", () => {
  const fails = (args: string[], dir: string): string => {
    try {
      scaffold(args, dir);
      throw new Error("expected the CLI to exit non-zero");
    } catch (err) {
      return String((err as { stderr?: string }).stderr ?? (err as Error).message);
    }
  };

  it("rejects an id that is not kebab-case", () => {
    expect(fails(["Not Kebab"], freshDir())).toMatch(/kebab-case/);
  });

  it("refuses to overwrite an existing capability", () => {
    const dir = freshDir();
    scaffold(["twice"], dir);
    expect(fails(["twice"], dir)).toMatch(/already exists/);
  });

  it("insists on a cron for a scheduled capability", () => {
    // Without this the manifest would load and then never fire, which is a
    // failure that looks like nothing at all.
    expect(fails(["timed", "--mode", "scheduled"], freshDir())).toMatch(/requires --cron/);
  });

  it("insists on an event for an event capability", () => {
    expect(fails(["reactive", "--mode", "event"], freshDir())).toMatch(/requires --on/);
  });
});

describe("the scaffold actually works", () => {
  it("loads into the registry with no problems", () => {
    const dir = freshDir();
    scaffold(["loadable"], dir);

    const h = harness({ capabilitiesDir: dir });
    expect(h.capabilities.problems()).toEqual([]);
    expect(h.capabilities.get("loadable")?.manifest.name).toBe("Loadable");
  });

  it("runs and puts a real item in the Inbox", async () => {
    // End to end on the promise the CLI prints: scaffold it, run it, see it.
    const dir = freshDir();
    scaffold(["runnable"], dir);

    const h = harness({ capabilitiesDir: dir });
    const report = await runCapability(h, "runnable");

    expect(report.status).toBe("ok");
    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0]!.status).toBe("pending");
  });

  it("is idempotent across runs, as its dedupe_key promises", async () => {
    const dir = freshDir();
    scaffold(["steady"], dir);

    const h = harness({ capabilitiesDir: dir });
    await runCapability(h, "steady");
    await runCapability(h, "steady");

    const rows = h.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM action_items").get();
    expect(rows?.n).toBe(1);
  });

  it("starts guided, so it works before any integration is connected", async () => {
    const dir = freshDir();
    scaffold(["fresh"], dir);

    const h = harness({ capabilitiesDir: dir });
    const type = h.capabilities.getType("fresh", "fresh-review");
    expect(type?.effectiveMode).toBe("guided");
    // Guided is a real registered adapter, not a degradation, so there is no
    // warning attached to it.
    expect(type?.degradedReason).toBeUndefined();
  });
});
