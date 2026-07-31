import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAskUserQuestions } from "../elicitation.js";

/**
 * Story 008, R1.4 / R1.5 / R1.6 — the prune is complete AND bounded.
 *
 * Two failure modes are guarded here, and they pull in opposite directions:
 *
 *  - UNDER-deletion: a leftover import, an orphaned env-var read, or a comment
 *    that still cites the removed module. Any of these leaves the tree
 *    describing a feature that no longer exists — the exact divergence the
 *    story exists to remove — and the import case additionally breaks the
 *    build.
 *  - OVER-deletion: `extractAskUserQuestions` and the `AskUserQuestion` type
 *    live in `elicitation.ts`, are UPSTREAM-owned, and feed the surviving form
 *    path. Removing them alongside the fork's module would break the very
 *    capability R1 keeps.
 *
 * The searched literals are assembled at runtime so this file can never match
 * itself, and its own path is excluded from the sweep regardless.
 */

const SELF = fileURLToPath(import.meta.url);
const TESTS_DIR = path.dirname(SELF);
const SRC_DIR = path.resolve(TESTS_DIR, "..");

/** `ask-user-question-fallback` — the retired module's slug. */
const MODULE_SLUG = ["ask", "user", "question", "fallback"].join("-");
/** `ACP_ASKUSERQUESTION_FALLBACK` — the retired feature gate. */
const RETIRED_ENV_VAR = ["ACP", "ASKUSERQUESTION", "FALLBACK"].join("_");

/** Every `.ts` file under `src/`, minus this guard itself. */
function sourceFiles(dir: string = SRC_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
    if (full === SELF) return [];
    return [full];
  });
}

/** Files whose text contains `needle`, reported relative to `src/`. */
function filesMentioning(needle: string): string[] {
  return sourceFiles()
    .filter((file) => fs.readFileSync(file, "utf8").includes(needle))
    .map((file) => path.relative(SRC_DIR, file));
}

describe("the AskUserQuestion fallback is gone from the tree (R1.4)", () => {
  it("no longer ships the fallback module or its dedicated suites", () => {
    const removed = [
      path.join(SRC_DIR, `${MODULE_SLUG}.ts`),
      path.join(TESTS_DIR, `${MODULE_SLUG}.test.ts`),
      path.join(TESTS_DIR, `${MODULE_SLUG}-integration.test.ts`),
    ];

    expect(removed.filter((file) => fs.existsSync(file))).toEqual([]);
  });

  it("leaves no file in src/ referencing the removed module (R1.5 covers comments too)", () => {
    // Imports break the build; a stale comment does not — which is why it
    // survives merges unnoticed and is swept here rather than trusted.
    expect(filesMentioning(MODULE_SLUG)).toEqual([]);
  });

  it("leaves no file in src/ reading the retired environment variable", () => {
    expect(filesMentioning(RETIRED_ENV_VAR)).toEqual([]);
  });
});

describe("the upstream-owned AskUserQuestion surface survives the prune (R1.6)", () => {
  it("still exports a working extractAskUserQuestions from elicitation.ts", () => {
    expect(typeof extractAskUserQuestions).toBe("function");

    const questions = extractAskUserQuestions({
      questions: [{ question: "Pick a color", options: [{ label: "red" }, { label: "blue" }] }],
    });

    expect(questions).toHaveLength(1);
    expect(questions?.[0].question).toBe("Pick a color");
  });

  it("returns null when there is nothing well-formed to ask", () => {
    expect(extractAskUserQuestions({ questions: [{ question: "no options", options: [] }] })).toBe(
      null,
    );
    expect(extractAskUserQuestions({})).toBe(null);
  });

  it("still declares the AskUserQuestion type in elicitation.ts", () => {
    // Types are erased at runtime, so presence is asserted on the source text:
    // the type is what the surviving form path is written against.
    const source = fs.readFileSync(path.join(SRC_DIR, "elicitation.ts"), "utf8");

    expect(source).toMatch(/export\s+type\s+AskUserQuestion\s*=/);
  });
});
