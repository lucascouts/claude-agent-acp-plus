import { describe, it, expect } from "vitest";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import {
  askUserQuestionFallbackEnabled,
  questionPermissionOptions,
  handleAskUserQuestionViaPermission,
} from "../ask-user-question-fallback.js";
import type { AskUserQuestion } from "../elicitation.js";

/**
 * Contract fixed by story 001 (R2.x, R3.x): the fallback module maps each
 * AskUserQuestion question to one sequential permission request. These tests
 * pin observable behavior only — option shape, answer accumulation, skip,
 * degrade, abort, and upstream-parity for malformed input.
 */

/** Outcome shape the injected permission-request function resolves with. */
type PermissionRequestOutcome =
  { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

type FallbackPermissionRequest = (req: {
  question: AskUserQuestion;
  options: PermissionOption[];
}) => Promise<PermissionRequestOutcome>;

/** Terse builder matching the SDK's AskUserQuestion schema (same as elicitation.test.ts). */
function mkQuestion(
  question: string,
  options: Array<{ label: string; description?: string }>,
  opts: { header?: string; multiSelect?: boolean } = {},
): AskUserQuestion {
  return {
    question,
    header: opts.header ?? "",
    multiSelect: opts.multiSelect ?? false,
    options: options.map((o) => ({
      label: o.label,
      description: o.description ?? "",
    })),
  } as AskUserQuestion;
}

/** Records every request and answers via the supplied per-call strategies. */
function mkRequestFake(
  strategies: Array<
    (req: { question: AskUserQuestion; options: PermissionOption[] }) => PermissionRequestOutcome
  >,
) {
  const calls: Array<{ question: AskUserQuestion; options: PermissionOption[] }> = [];
  const request: FallbackPermissionRequest = async (req) => {
    calls.push(req);
    const strategy = strategies[calls.length - 1];
    if (!strategy) {
      throw new Error(`unexpected extra permission request #${calls.length}`);
    }
    return strategy(req);
  };
  return { calls, request };
}

const selectLabel = (label: string) => (): PermissionRequestOutcome => ({
  outcome: "selected",
  optionId: label,
});

const selectSkip = (req: {
  question: AskUserQuestion;
  options: PermissionOption[];
}): PermissionRequestOutcome => {
  const skip = req.options.find((o) => o.kind === "reject_once");
  if (!skip) throw new Error("no reject_once (skip) option present");
  return { outcome: "selected", optionId: skip.optionId };
};

describe("askUserQuestionFallbackEnabled", () => {
  it("defaults to enabled when the variable is unset", () => {
    expect(askUserQuestionFallbackEnabled({})).toBe(true);
  });

  it.each(["1", "true"])("is enabled when ACP_ASKUSERQUESTION_FALLBACK=%s", (value) => {
    expect(askUserQuestionFallbackEnabled({ ACP_ASKUSERQUESTION_FALLBACK: value })).toBe(true);
  });

  it.each(["0", "false"])("is disabled when ACP_ASKUSERQUESTION_FALLBACK=%s", (value) => {
    expect(askUserQuestionFallbackEnabled({ ACP_ASKUSERQUESTION_FALLBACK: value })).toBe(false);
  });
});

describe("questionPermissionOptions", () => {
  it("maps each option to allow_once with optionId = label, appends the skip option last", () => {
    const q = mkQuestion("Favorite color?", [
      { label: "Red" },
      { label: "Blue", description: "calm and steady" },
    ]);

    const options = questionPermissionOptions(q);

    expect(options).toHaveLength(3);
    expect(options[0]).toMatchObject({ kind: "allow_once", optionId: "Red", name: "Red" });
    expect(options[1]).toMatchObject({
      kind: "allow_once",
      optionId: "Blue",
      name: "Blue — calm and steady",
    });
    expect(options[2]).toMatchObject({ kind: "reject_once", name: "Skip this question" });
  });

  it("keeps option order and does not flatten descriptions into optionIds", () => {
    const q = mkQuestion("Pick", [
      { label: "A", description: "first" },
      { label: "B" },
      { label: "C", description: "third" },
    ]);

    const allowIds = questionPermissionOptions(q)
      .filter((o) => o.kind === "allow_once")
      .map((o) => o.optionId);

    expect(allowIds).toEqual(["A", "B", "C"]);
  });
});

describe("handleAskUserQuestionViaPermission", () => {
  const q1 = mkQuestion("Favorite color?", [{ label: "Red" }, { label: "Blue" }]);
  const q2 = mkQuestion("Tabs or spaces?", [{ label: "Tabs" }, { label: "Spaces" }]);

  it("asks each question sequentially and returns allow with accumulated answers", async () => {
    const toolInput = { questions: [q1, q2], somethingElse: "keep-me" };
    const { calls, request } = mkRequestFake([selectLabel("Blue"), selectLabel("Tabs")]);

    const result = await handleAskUserQuestionViaPermission(
      toolInput,
      request,
      new AbortController().signal,
    );

    expect(calls.map((c) => c.question.question)).toEqual(["Favorite color?", "Tabs or spaces?"]);
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [q1, q2],
        somethingElse: "keep-me",
        answers: { "Favorite color?": "Blue", "Tabs or spaces?": "Tabs" },
      },
    });
  });

  it("omits a skipped question from answers and continues the sequence", async () => {
    const toolInput = { questions: [q1, q2] };
    const { calls, request } = mkRequestFake([selectSkip, selectLabel("Spaces")]);

    const result = await handleAskUserQuestionViaPermission(
      toolInput,
      request,
      new AbortController().signal,
    );

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Tabs or spaces?": "Spaces" } },
    });
    const answers = (result as unknown as { updatedInput: { answers: Record<string, unknown> } })
      .updatedInput.answers;
    expect(Object.keys(answers)).toEqual(["Tabs or spaces?"]);
  });

  it("degrades a multiSelect question to a single selected label", async () => {
    const multi = mkQuestion("Toppings?", [{ label: "Cheese" }, { label: "Olives" }], {
      multiSelect: true,
    });
    const { request } = mkRequestFake([selectLabel("Cheese")]);

    const result = await handleAskUserQuestionViaPermission(
      { questions: [multi] },
      request,
      new AbortController().signal,
    );

    const answers = (result as unknown as { updatedInput: { answers: Record<string, unknown> } })
      .updatedInput.answers;
    expect(answers["Toppings?"]).toBe("Cheese");
    expect(typeof answers["Toppings?"]).toBe("string");
  });

  it("aborts the tool call when a request resolves as cancelled", async () => {
    const { calls, request } = mkRequestFake([
      selectLabel("Red"),
      () => ({ outcome: "cancelled" }),
    ]);

    await expect(
      handleAskUserQuestionViaPermission(
        { questions: [q1, q2] },
        request,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Tool use aborted");
    expect(calls).toHaveLength(2);
  });

  it("aborts immediately on an already-aborted signal without asking anything", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, request } = mkRequestFake([]);

    await expect(
      handleAskUserQuestionViaPermission({ questions: [q1] }, request, controller.signal),
    ).rejects.toThrow("Tool use aborted");
    expect(calls).toHaveLength(0);
  });

  it("mirrors the upstream deny for input with no parseable questions", async () => {
    const { calls, request } = mkRequestFake([]);

    const result = await handleAskUserQuestionViaPermission(
      { notQuestions: true },
      request,
      new AbortController().signal,
    );

    expect(result).toEqual({
      behavior: "deny",
      message: "AskUserQuestion called with no valid questions.",
    });
    expect(calls).toHaveLength(0);
  });
});
