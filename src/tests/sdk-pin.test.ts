import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent SDK pin is a behaviour contract, not a dependency number.
 *
 * The SDK bundles the Claude Code CLI, and the CLI has two measured cadence
 * cliffs this adapter's turn accounting reasons from:
 *
 *   - CLI >=2.1.270 withholds `idle` while background agents run. The
 *     held-turn path in acp-agent.ts expects the opposite -- one idle per
 *     processing cycle, never a single "all drained" signal -- and spends an
 *     `owedTrailingIdles` debt on each. Upstream sweeps that counter at the
 *     `running` transition (d3205ab) precisely because the cadence changed;
 *     this adapter does not carry the sweep.
 *   - CLI >=2.1.274 answers queued background completions with placeholder
 *     results (`num_turns: 0`).
 *
 * 0.3.269 bundles CLI 2.1.269, below both. Crossing either is a port, not a
 * bump: it can hang a turn that spawned background subagents.
 *
 * WHY THIS TEST EXISTS, when a sibling guard already lives in the fork.
 * The fork's src/tests/deps.test.ts asserts the same contract, but the two are
 * independent repositories with independent CI -- this repository never runs
 * that file. On 2026-09-22 Dependabot PR #106 raised the pin to 0.3.272, every
 * check here passed, and it was merged; the crossing surfaced only when the
 * fork's guard was run by hand. A guard in the other repository cannot fail a
 * build in this one.
 *
 * WHY THE REST OF THE SUITE CANNOT CATCH IT. The idle cadence under test comes
 * from the doubles in session-doubles.ts, which emit the pre-2.1.270 sequence.
 * Those 1200-odd tests stay green across a crossing by construction -- they
 * never speak to the bundled CLI. This file asserts the pin itself for that
 * reason, and is the only thing here that would go red.
 *
 * RAISING THE PIN. Change PINNED in the same commit that ports the accounting,
 * never before it, and move the fork first: the fork leads, the mirror follows
 * (the fork's guard enforces that order from its side).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIRROR_ROOT = join(HERE, "..", "..");
const FORK_ROOT = join(MIRROR_ROOT, "..", "fork");

const SDK = "@anthropic-ai/claude-agent-sdk";
const PINNED = "0.3.269";

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function dependenciesOf(root: string): Record<string, string> {
  return (readJson(join(root, "package.json")).dependencies ?? {}) as Record<string, string>;
}

describe("agent SDK pin", () => {
  it(`pins the SDK at exactly ${PINNED}`, () => {
    expect(dependenciesOf(MIRROR_ROOT)[SDK]).toBe(PINNED);
  });

  it("carries no range operator, so a later publish cannot be taken silently", () => {
    // `^0.3.269` and `0.3.269` install the same thing TODAY and diverge at the
    // next publish. Equality alone would accept the range on the day it is
    // introduced, which is exactly when it is still invisible.
    const spec = dependenciesOf(MIRROR_ROOT)[SDK] ?? "";
    expect(spec).not.toMatch(/[\^~><*]|\s-\s|\|\|/);
  });

  it("resolves the installed copy to the version the spec names", () => {
    // A spec edited without an install is a pin nothing has exercised, and
    // `npm ci` is what makes the two agree.
    const installed = join(MIRROR_ROOT, "node_modules", SDK, "package.json");
    expect(existsSync(installed)).toBe(true);
    expect(readJson(installed).version).toBe(PINNED);
  });

  it("agrees with the fork where the fork is checked out", (ctx) => {
    // The two are independent repositories: an absent sibling is a skip, never
    // a red. In CI this repository is cloned alone, so only the clauses above
    // run -- which is the point, since those are the ones a bump trips.
    if (!existsSync(join(FORK_ROOT, "package.json"))) {
      ctx.skip(`skipped: no sibling checkout at ${FORK_ROOT}`);
      return;
    }
    expect(dependenciesOf(FORK_ROOT)[SDK]).toBe(PINNED);
  });
});
