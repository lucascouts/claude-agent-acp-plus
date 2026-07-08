/**
 * All `/rewind` command logic, isolated from the ACP adapter so it can be unit
 * tested without a live SDK session. The adapter (see acp-agent.ts) wires these
 * helpers in by injecting the ACP client, the SDK `query` handle, and a
 * `getSessionMessages` reader; this module never touches the transport itself.
 *
 * Responsibilities (story 006, R3.2–R3.6):
 *   - parse a `/rewind` prompt into a list / restore / invalid intent
 *     (`parseRewindInvocation`);
 *   - derive the checkpoint list from the session transcript — real user
 *     prompts only, most recent first, 1-based (`listCheckpoints`);
 *   - format the user-facing strings (`formatCheckpointList`,
 *     `formatRewindResult`, `formatRewindError`);
 *   - orchestrate one command end to end, emitting every message through the
 *     injected client before resolving (`handleRewindCommand`).
 *
 * `stripLocalCommandMetadata` is reused from acp-agent.ts (its single source of
 * truth) rather than duplicated, so the definition of a "local-command marker
 * row" stays in sync; the import is side-effect-free (acp-agent.ts runs nothing
 * at module top level).
 */

import type { RewindFilesResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { stripLocalCommandMetadata } from "./acp-agent.js";

/** Maximum Unicode code points kept from a prompt when building its checkpoint excerpt. */
const EXCERPT_MAX = 60;

/** A rewindable point in the session: a real user prompt tracked by its SDK uuid. */
export type Checkpoint = { index: number; uuid: string; excerpt: string };

/** Parsed intent of a `/rewind` prompt; the parser returns `null` for non-commands. */
export type RewindInvocation =
  { kind: "list" } | { kind: "restore"; index: number } | { kind: "invalid"; raw: string };

/**
 * Parse a raw prompt into a `/rewind` intent, or `null` when the prompt is not a
 * `/rewind` command at all.
 *
 * The command token is matched exactly, so `"/rewindx"`, `"/compact"` and plain
 * prose all return `null`. A bare `/rewind` (trailing whitespace allowed) is a
 * `list` request; `/rewind <integer>` is a `restore` request; any other argument
 * is `invalid`, carrying the trimmed raw argument text so the caller can echo it.
 *
 * The whole invocation must sit on a single line: any newline surviving the
 * trim makes the prompt NOT a `/rewind` command (`null`). Without this,
 * `\s+` between command and argument would accept a line break, and a pasted
 * two-line snippet like `"/rewind\n2"` would silently restore files — a
 * destructive surprise for what the user meant as plain text.
 *
 * @param promptText Raw prompt text as typed by the user.
 */
export function parseRewindInvocation(promptText: string): RewindInvocation | null {
  // Single-line anchor (see doc above): `\r` is included so a CR-separated
  // paste cannot slip past the check either.
  if (/[\r\n]/.test(promptText.trim())) {
    return null;
  }
  const match = /^\/rewind(?:\s+(.*))?$/.exec(promptText.trim());
  if (!match) {
    return null;
  }
  const arg = match[1]?.trim() ?? "";
  if (arg === "") {
    return { kind: "list" };
  }
  if (/^-?\d+$/.test(arg)) {
    return { kind: "restore", index: Number.parseInt(arg, 10) };
  }
  return { kind: "invalid", raw: arg };
}

/** Narrow an unknown value to a plain object we can read string-keyed fields off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read the fields we care about from a transcript row, or `null` if not a user row. */
function asUserRow(
  message: SDKMessage,
): { uuid: string; content: unknown; parentToolUseId: string | null } | null {
  const row = message as unknown as {
    type?: unknown;
    uuid?: unknown;
    parent_tool_use_id?: unknown;
    message?: { content?: unknown };
  };
  if (row.type !== "user") {
    return null;
  }
  if (typeof row.uuid !== "string" || row.uuid === "") {
    return null;
  }
  const parentToolUseId =
    typeof row.parent_tool_use_id === "string" ? row.parent_tool_use_id : null;
  return { uuid: row.uuid, content: row.message?.content, parentToolUseId };
}

/** Whether `content` carries a tool_result block (a synthetic tool-output row). */
function hasToolResultBlock(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return (content as unknown[]).some((block) => isRecord(block) && block.type === "tool_result");
}

/** Flatten user-message content (a string or a block array) to its plain text. */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content as unknown[]) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join(" ");
}

/** Collapse whitespace/newlines to single spaces and clip to the excerpt length.
 *  The clip counts Unicode code points, not UTF-16 code units: `String.slice`
 *  at a fixed offset can split a surrogate pair (e.g. an emoji sitting on the
 *  boundary) and emit a lone surrogate — invalid Unicode that Zed's serde_json
 *  rejects, dropping the whole session/update notification carrying the
 *  excerpt. `toWellFormed()` additionally scrubs any lone surrogate already
 *  present in the transcript text (JSON.parse admits them via `\uD800`-style
 *  escapes) for the same reason. */
function toExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return Array.from(collapsed).slice(0, EXCERPT_MAX).join("").toWellFormed();
}

/**
 * Build the rewind checkpoint list from a session transcript.
 *
 * Only REAL user prompts are checkpoints: rows carrying a `parent_tool_use_id`,
 * tool_result rows, and local-command marker rows (`<command-name>…`, which
 * `stripLocalCommandMetadata` reduces to null) are all skipped. The result is
 * ordered most recent first with a 1-based `index` (most recent = 1); each
 * `excerpt` is the first 60 code points of the prompt on a single line.
 *
 * @param messages Session transcript in chronological order (SDK messages).
 */
export function listCheckpoints(messages: SDKMessage[]): Checkpoint[] {
  const prompts: Array<{ uuid: string; excerpt: string }> = [];
  for (const message of messages) {
    const row = asUserRow(message);
    if (!row) {
      continue;
    }
    if (row.parentToolUseId !== null) {
      continue;
    }
    if (hasToolResultBlock(row.content)) {
      continue;
    }
    const stripped = stripLocalCommandMetadata(row.content);
    if (stripped === null) {
      continue;
    }
    const excerpt = toExcerpt(extractText(stripped));
    if (excerpt === "") {
      continue;
    }
    prompts.push({ uuid: row.uuid, excerpt });
  }
  return prompts.reverse().map((prompt, position) => ({
    index: position + 1,
    uuid: prompt.uuid,
    excerpt: prompt.excerpt,
  }));
}

/**
 * Render the checkpoint list as a numbered, user-facing message. An empty list
 * yields a "nothing to rewind" notice instead (R3.6).
 *
 * @param cps Checkpoints, already ordered most recent first.
 */
export function formatCheckpointList(cps: Checkpoint[]): string {
  if (cps.length === 0) {
    return "There is nothing to rewind — this session has no earlier prompts yet.";
  }
  const lines = cps.map((cp) => `${cp.index}. ${cp.excerpt}`);
  return [
    "Rewind checkpoints (most recent first):",
    "",
    ...lines,
    "",
    "Restore files to one with `/rewind <n>`.",
  ].join("\n");
}

/**
 * Confirm a completed rewind, naming the checkpoint that was restored by its
 * index and excerpt (R3.4).
 *
 * @param cp The checkpoint whose files were restored.
 */
export function formatRewindResult(cp: Checkpoint): string {
  return `Rewound files to checkpoint ${cp.index}: "${cp.excerpt}".`;
}

/**
 * Build a `/rewind` usage/error message. Always names the `/rewind` command and,
 * when at least one checkpoint exists, the valid index range (R3.5). An optional
 * `detail` (e.g. the reason a restore failed) is shown ahead of the usage line —
 * this is how the orchestrator surfaces a failure WITHOUT ever claiming success.
 *
 * @param checkpointCount Number of available checkpoints (0 when none/unknown).
 * @param detail Optional human-readable explanation shown before the usage line.
 */
export function formatRewindError(checkpointCount: number, detail?: string): string {
  const range = checkpointCount > 0 ? ` (valid indices 1–${checkpointCount})` : "";
  const usage = `Usage: \`/rewind\` to list checkpoints, or \`/rewind <n>\`${range} to restore.`;
  return detail ? `${detail}\n\n${usage}` : usage;
}

/** Injected collaborators for {@link handleRewindCommand}. */
export interface RewindDeps {
  /** ACP session the command was issued in. */
  sessionId: string;
  /** ACP client used to stream user-facing messages back to the editor. */
  client: {
    sessionUpdate(notification: {
      sessionId: string;
      update: { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } };
    }): Promise<void>;
  };
  /** SDK query handle exposing file checkpointing. */
  query: { rewindFiles(userMessageId: string): Promise<RewindFilesResult> };
  /** Reader for the session transcript (chronological SDK messages). */
  getSessionMessages(sessionId: string): Promise<SDKMessage[]>;
}

/** Coerce an unknown thrown value into a short, human-readable reason. */
function reasonText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

/** Emit one user-facing text chunk through the injected ACP client. */
async function emit(deps: RewindDeps, text: string): Promise<void> {
  await deps.client.sessionUpdate({
    sessionId: deps.sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

/**
 * Drive a parsed `/rewind` invocation end to end, streaming every user-facing
 * message through `deps.client` before the returned promise resolves.
 *
 * `list` fetches the transcript and emits the numbered checkpoint list (or the
 * nothing-to-rewind notice). `restore` fetches + rebuilds the list, validates
 * the requested index, and on a hit calls `query.rewindFiles` with the tracked
 * uuid inside a try/catch — a rejection (or a `canRewind: false` result) is
 * reported via {@link formatRewindError} and never claims success. An `invalid`
 * invocation, an out-of-range index, or a failed transcript read each emit an
 * error and leave files untouched (`rewindFiles` is never called); the
 * `invalid` path still reads the transcript so its usage message can name the
 * valid range (R3.5), degrading to the rangeless message if that read fails.
 *
 * Failure handling: `getSessionMessages` and `query.rewindFiles` rejections
 * are caught and surfaced as user-facing messages. A rejection from
 * `deps.client.sessionUpdate` itself (the channel those messages are emitted
 * on) is NOT caught here — it propagates to the caller, which guards it.
 *
 * @param deps Injected client, query handle, transcript reader and session id.
 * @param invocation Parsed `/rewind` intent from {@link parseRewindInvocation}.
 */
export async function handleRewindCommand(
  deps: RewindDeps,
  invocation: RewindInvocation,
): Promise<void> {
  if (invocation.kind === "invalid") {
    // R3.5 wants errors to carry usage + the valid range; the range needs the
    // checkpoint count, so read the transcript here too. The invalid argument
    // is the error being reported, though, so a failed read degrades to the
    // rangeless usage message instead of masking it with a transcript error.
    let checkpointCount = 0;
    try {
      checkpointCount = listCheckpoints(await deps.getSessionMessages(deps.sessionId)).length;
    } catch {
      // Rangeless fallback: checkpointCount stays 0.
    }
    await emit(
      deps,
      formatRewindError(checkpointCount, `"${invocation.raw}" is not a valid checkpoint number.`),
    );
    return;
  }

  let checkpoints: Checkpoint[];
  try {
    checkpoints = listCheckpoints(await deps.getSessionMessages(deps.sessionId));
  } catch (error) {
    await emit(
      deps,
      formatRewindError(0, `Could not read the session history: ${reasonText(error)}.`),
    );
    return;
  }

  if (invocation.kind === "list") {
    await emit(deps, formatCheckpointList(checkpoints));
    return;
  }

  const checkpoint = checkpoints.find((cp) => cp.index === invocation.index);
  if (!checkpoint) {
    await emit(
      deps,
      formatRewindError(checkpoints.length, `There is no checkpoint ${invocation.index}.`),
    );
    return;
  }

  try {
    const result = await deps.query.rewindFiles(checkpoint.uuid);
    if (result.canRewind === false) {
      await emit(
        deps,
        formatRewindError(
          checkpoints.length,
          `Rewind failed: ${result.error ?? "the SDK could not rewind these files"}.`,
        ),
      );
      return;
    }
  } catch (error) {
    await emit(deps, formatRewindError(checkpoints.length, `Rewind failed: ${reasonText(error)}.`));
    return;
  }

  await emit(deps, formatRewindResult(checkpoint));
}
