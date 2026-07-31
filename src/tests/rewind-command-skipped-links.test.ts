import { describe, it, expect, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { formatRewindResult, handleRewindCommand } from "../rewind-command.js";
import type { Checkpoint } from "../rewind-command.js";

/**
 * Story 009 — a rewind that silently refused files must not report plain success.
 *
 * SDK 0.3.220 added `RewindFilesResult.skippedLinks`: a count of tracked files
 * NOT restored because a symlink, hard link or other non-regular file was found
 * at the tracked path, because the parent directory no longer resolves where it
 * pointed, or because the backup could not be safely read (sdk.d.ts:2700-2702).
 * The module ignored it, so `Rewound files to checkpoint N: "…"` was emitted
 * unconditionally — a sentence that can be false.
 *
 * The suite is deliberately lopsided. Two cases state the new behavior; the
 * other six are UNCHANGED-BEHAVIOR guards that pass today and must keep passing.
 * That asymmetry is the point: the fix widens a variable's scope inside the one
 * function that restores files, so the risk is not that the new clause is wrong
 * but that something around it moves.
 *
 * The module never passes `dryRun`, so every call is a real rewind and the field
 * is always populated when refusals occur — the SDK's dryRun caveat cannot apply
 * here. The SDK exposes a COUNT only, never the paths, so no case asserts names.
 */

const CP: Checkpoint = { index: 1, uuid: "uuid-c", excerpt: "Third prompt about cherries" };

/** The exact string emitted today, and the one R1.2 freezes for the no-refusal case. */
const TODAY = 'Rewound files to checkpoint 1: "Third prompt about cherries".';

function userMsg(uuid: string, content: unknown): SDKMessage {
  return {
    type: "user",
    uuid,
    parent_tool_use_id: null,
    message: { role: "user", content },
  } as unknown as SDKMessage;
}

const TRANSCRIPT: SDKMessage[] = [userMsg("uuid-c", "Third prompt about cherries")];

/** Like the sibling suite's helper, but the rewind result is a parameter. */
function mkDeps(result: unknown | Error) {
  const chunks: string[] = [];
  const client = {
    sessionUpdate: vi.fn(
      async (n: {
        sessionId: string;
        update: { sessionUpdate: string; content?: { type: string; text: string } };
      }) => {
        if (n.update.sessionUpdate === "agent_message_chunk" && n.update.content?.type === "text") {
          chunks.push(n.update.content.text);
        }
      },
    ),
  };
  const rewindFiles = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const deps = {
    sessionId: "sess-1",
    client,
    query: { rewindFiles },
    getSessionMessages: vi.fn(async () => TRANSCRIPT),
  } as unknown as Parameters<typeof handleRewindCommand>[0];
  return { deps, chunks, rewindFiles };
}

const restore = { kind: "restore", index: 1 } as unknown as Parameters<
  typeof handleRewindCommand
>[1];

describe("formatRewindResult — refusal reporting (R1)", () => {
  it("(R1.1, R1.4) states the count and uses plural wording when files were refused", () => {
    const text = formatRewindResult(CP, 2);

    expect(text.startsWith(TODAY)).toBe(true);
    expect(text.length).toBeGreaterThan(TODAY.length);
    expect(text).toContain("2");
    expect(text).toMatch(/files/);
  });

  it("(R1.4) uses singular wording for exactly one refused file", () => {
    const text = formatRewindResult(CP, 1);

    expect(text.startsWith(TODAY)).toBe(true);
    expect(text).toMatch(/\b1 file\b/);
    expect(text).not.toMatch(/\b1 files\b/);
  });

  it("(R1.3) keeps the confirmation on a single line", () => {
    expect(formatRewindResult(CP, 2)).not.toContain("\n");
  });
});

describe("formatRewindResult — unchanged behavior guards (R1.2)", () => {
  // These pass today. They are the reason the fix is safe, not evidence it happened.
  it("is byte-identical to today's string when the count is absent", () => {
    expect(formatRewindResult(CP)).toBe(TODAY);
  });

  it("is byte-identical when the count is zero", () => {
    expect(formatRewindResult(CP, 0)).toBe(TODAY);
  });

  it("is byte-identical when the count is not a number", () => {
    expect(formatRewindResult(CP, "2" as unknown as number)).toBe(TODAY);
  });
});

describe("handleRewindCommand — the failure path stays untouched (R2)", () => {
  it("(R1.1) surfaces the refusal through the real restore path", async () => {
    const { deps, chunks } = mkDeps({ skippedLinks: 2 });

    await handleRewindCommand(deps, restore);

    const text = chunks.join("");
    expect(text).toContain("Rewound files to checkpoint 1");
    expect(text).toContain("2");
    expect(text.length).toBeGreaterThan(TODAY.length);
  });

  it("(R2.1) emits no confirmation when canRewind is false, even with refusals", async () => {
    const { deps, chunks } = mkDeps({ canRewind: false, error: "nope", skippedLinks: 3 });

    await handleRewindCommand(deps, restore);

    const text = chunks.join("");
    expect(text).not.toContain("Rewound files to checkpoint");
    expect(text).toContain("nope");
  });

  it("(R2.2) emits no confirmation when rewindFiles throws", async () => {
    const { deps, chunks } = mkDeps(new Error("disk on fire"));

    await handleRewindCommand(deps, restore);

    const text = chunks.join("");
    expect(text).not.toContain("Rewound files to checkpoint");
    expect(text).toContain("disk on fire");
  });
});
