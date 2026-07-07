/**
 * Fallback for the built-in AskUserQuestion tool when the connected client does
 * NOT advertise `elicitation.form`. Upstream disables the tool for such clients;
 * this module lets the agent instead route each question through ACP's
 * `session/request_permission` dialog. The path is gated by the
 * `ACP_ASKUSERQUESTION_FALLBACK` env var so it can be turned off to restore
 * byte-for-byte upstream behavior.
 *
 * Alongside the env gate this module provides the pure mapping/orchestration
 * helpers (`questionPermissionOptions`, `handleAskUserQuestionViaPermission`);
 * the ACP client is injected by the adapter that wires them in.
 */

import { randomUUID } from "node:crypto";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import { extractAskUserQuestions, type AskUserQuestion } from "./elicitation.js";

/**
 * Whether the AskUserQuestion permission fallback is enabled for clients lacking
 * `elicitation.form`. Defaults ON: only an explicit `0` or `false` (trimmed,
 * case-insensitive) turns it off; any other value — unset, `1`, `true`, … —
 * leaves it on.
 *
 * @param env Environment map to read `ACP_ASKUSERQUESTION_FALLBACK` from (pass
 *   `process.env`).
 */
export function askUserQuestionFallbackEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.ACP_ASKUSERQUESTION_FALLBACK;
  if (raw === undefined) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

/**
 * Map one AskUserQuestion question to the options shown in ACP's
 * `session/request_permission` dialog: one `allow_once` option per choice (in
 * order) followed by a trailing `reject_once` "Skip this question" option.
 *
 * Each choice's `optionId` is its bare `label` — the value the tool records as
 * the answer — so the description is never folded into the id; a non-empty
 * `description` is instead appended to the human-readable `name` as
 * `"<label> — <description>"`. The skip option is given a random `optionId`
 * that cannot collide with any label, so the orchestrator can recognize a skip
 * by id alone.
 *
 * @param question The single question whose choices become permission options.
 */
export function questionPermissionOptions(question: AskUserQuestion): PermissionOption[] {
  const options: PermissionOption[] = question.options.map((option) => ({
    kind: "allow_once",
    optionId: option.label,
    name: option.description ? `${option.label} — ${option.description}` : option.label,
  }));
  options.push({
    kind: "reject_once",
    name: "Skip this question",
    optionId: randomUUID(),
  });
  return options;
}

/**
 * Route an AskUserQuestion tool call through ACP permission requests rather than
 * a form elicitation, for clients that lack `elicitation.form`. Each question is
 * asked sequentially via the injected `requestPermission`; the selected label is
 * accumulated into `answers` (keyed by the question text), a skipped question is
 * omitted, and a multi-select question naturally degrades to a single label
 * since each option is single-select here.
 *
 * Mirrors the upstream form handler's contract: input with no parseable
 * questions denies with the identical message, and an aborted signal or a
 * cancelled request throws `"Tool use aborted"`, discarding every accumulated
 * answer. On success it returns the original `toolInput` augmented with
 * `answers` as `updatedInput`.
 *
 * Pure and injectable — the real ACP client is wired in by the adapter — so the
 * orchestration can be exercised without a transport.
 *
 * @param toolInput Raw AskUserQuestion tool input (expected to carry `questions`).
 * @param requestPermission Injected permission-request function, invoked once per
 *   question, resolving to the user's selection or a cancellation.
 * @param signal Abort signal for the tool call; checked on entry and around each
 *   request.
 */
export async function handleAskUserQuestionViaPermission(
  toolInput: Record<string, unknown>,
  requestPermission: (req: {
    question: AskUserQuestion;
    options: PermissionOption[];
  }) => Promise<{ outcome: "selected"; optionId: string } | { outcome: "cancelled" }>,
  signal: AbortSignal,
): Promise<
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }
> {
  if (signal.aborted) {
    throw new Error("Tool use aborted");
  }

  const questions = extractAskUserQuestions(toolInput);
  if (!questions) {
    return { behavior: "deny", message: "AskUserQuestion called with no valid questions." };
  }

  const answers: Record<string, string> = {};
  for (const question of questions) {
    const options = questionPermissionOptions(question);
    const skipOptionId = options.find((option) => option.kind === "reject_once")?.optionId;
    const outcome = await requestPermission({ question, options });
    if (outcome.outcome === "cancelled" || signal.aborted) {
      throw new Error("Tool use aborted");
    }
    if (outcome.optionId === skipOptionId) {
      continue;
    }
    answers[question.question] = outcome.optionId;
  }

  return { behavior: "allow", updatedInput: { ...toolInput, answers } };
}
