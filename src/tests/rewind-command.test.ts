import { describe, it, expect, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  parseRewindInvocation,
  listCheckpoints,
  formatCheckpointList,
  formatRewindResult,
  handleRewindCommand,
  type Checkpoint,
} from "../rewind-command.js";

/**
 * Contract fixed by story 006 (R3.2–R3.6): the rewind-command module parses
 * `/rewind` invocations, derives the checkpoint list from the session's SDK
 * transcript (real user prompts only, most recent first, 1-based), formats
 * user-facing strings, and drives the restore through `query.rewindFiles`
 * with the tracked SDK message uuid. Unit level: mock deps, no SDK.
 */

/** Synthetic SDKMessage user row (shape mirrored from sdk.d.ts SDKUserMessage). */
function userMsg(
  uuid: string,
  content: unknown,
  parentToolUseId: string | null = null,
): SDKMessage {
  return {
    type: "user",
    uuid,
    parent_tool_use_id: parentToolUseId,
    message: { role: "user", content },
  } as unknown as SDKMessage;
}

function assistantMsg(uuid: string, text: string): SDKMessage {
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SDKMessage;
}

// Chronological transcript: three real prompts (a, b, c), assistant replies,
// a local-command metadata row (the SDK persists `/model`-style invocations
// wrapped in marker tags; see stripLocalCommandMetadata in acp-agent.ts), and
// a tool-result user row — only the real prompts are rewind checkpoints.
const TRANSCRIPT: SDKMessage[] = [
  userMsg("uuid-a", "First prompt about apples"),
  assistantMsg("uuid-a-reply", "sure"),
  userMsg("uuid-b", [{ type: "text", text: "Second prompt about bananas" }]),
  assistantMsg("uuid-b-reply", "done"),
  userMsg("uuid-cmd", "<command-name>/model</command-name><command-args></command-args>"),
  userMsg("uuid-tool", [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }], "toolu_1"),
  userMsg("uuid-c", "Third prompt about cherries"),
];

describe("parseRewindInvocation", () => {
  it("parses a bare /rewind as a list request", () => {
    expect(parseRewindInvocation("/rewind")).toEqual({ kind: "list" });
  });

  it("parses /rewind N as a restore request", () => {
    expect(parseRewindInvocation("/rewind 2")).toEqual({ kind: "restore", index: 2 });
  });

  it("flags a non-numeric argument as invalid, keeping the raw text", () => {
    expect(parseRewindInvocation("/rewind abc")).toEqual({ kind: "invalid", raw: "abc" });
  });

  it("returns null for anything that is not a /rewind command", () => {
    expect(parseRewindInvocation("hello")).toBeNull();
    expect(parseRewindInvocation("/compact")).toBeNull();
    expect(parseRewindInvocation("/rewindx")).toBeNull();
  });
});

describe("listCheckpoints", () => {
  it("returns an empty list for an empty transcript (R3.6)", () => {
    expect(listCheckpoints([])).toEqual([]);
  });

  it("lists real user prompts only, most recent first, 1-based (R3.2)", () => {
    const cps = listCheckpoints(TRANSCRIPT);

    expect(cps.map((c) => ({ index: c.index, uuid: c.uuid }))).toEqual([
      { index: 1, uuid: "uuid-c" },
      { index: 2, uuid: "uuid-b" },
      { index: 3, uuid: "uuid-a" },
    ]);
    expect(cps[0].excerpt).toContain("cherries");
    expect(cps[1].excerpt).toContain("bananas");
    expect(cps[2].excerpt).toContain("apples");
  });

  it("truncates the excerpt to the first 60 characters", () => {
    const long =
      "Please refactor the entire authentication module and update every call site accordingly";
    const cps = listCheckpoints([userMsg("uuid-long", long)]);
    expect(cps[0].excerpt).toBe(long.slice(0, 60));
  });

  it("keeps the excerpt single-line", () => {
    const cps = listCheckpoints([userMsg("uuid-nl", "line one\nline two")]);
    expect(cps[0].excerpt).not.toContain("\n");
    expect(cps[0].excerpt).toContain("line one");
  });
});

describe("checkpoint formatting", () => {
  const CPS: Checkpoint[] = [
    { index: 1, uuid: "uuid-c", excerpt: "most recent prompt" },
    { index: 2, uuid: "uuid-b", excerpt: "older prompt" },
  ];

  it("numbers every checkpoint entry with its excerpt (R3.2)", () => {
    const text = formatCheckpointList(CPS);
    expect(text).toContain("1");
    expect(text).toContain("most recent prompt");
    expect(text).toContain("2");
    expect(text).toContain("older prompt");
  });

  it("states there is nothing to rewind for an empty list (R3.6)", () => {
    expect(formatCheckpointList([])).toMatch(/nothing to rewind/i);
  });

  it("names the restored checkpoint in the result message (R3.4)", () => {
    const text = formatRewindResult(CPS[1]);
    expect(text).toContain("2");
    expect(text).toContain("older prompt");
  });
});

describe("handleRewindCommand", () => {
  type Invocation = Parameters<typeof handleRewindCommand>[1];
  type Deps = Parameters<typeof handleRewindCommand>[0];

  function mkDeps(messages: SDKMessage[] | Error) {
    const chunks: string[] = [];
    const sessionIds: string[] = [];
    const client = {
      sessionUpdate: vi.fn(
        async (n: {
          sessionId: string;
          update: { sessionUpdate: string; content?: { type: string; text: string } };
        }) => {
          sessionIds.push(n.sessionId);
          if (
            n.update.sessionUpdate === "agent_message_chunk" &&
            n.update.content?.type === "text"
          ) {
            chunks.push(n.update.content.text);
          }
        },
      ),
    };
    const rewindFiles = vi.fn(async () => ({}));
    const getSessionMessages = vi.fn(async () => {
      if (messages instanceof Error) throw messages;
      return messages;
    });
    const deps = {
      sessionId: "sess-1",
      client,
      query: { rewindFiles },
      getSessionMessages,
    } as unknown as Deps;
    return { deps, chunks, sessionIds, rewindFiles };
  }

  const invocation = (v: unknown) => v as Invocation;

  it("emits the numbered checkpoint list without touching files (R3.2)", async () => {
    const { deps, chunks, sessionIds, rewindFiles } = mkDeps(TRANSCRIPT);

    await handleRewindCommand(deps, invocation({ kind: "list" }));

    const text = chunks.join("");
    expect(text).toContain("1");
    expect(text).toContain("cherries");
    expect(text).toContain("3");
    expect(text).toContain("apples");
    expect(rewindFiles).not.toHaveBeenCalled();
    expect(sessionIds).toContain("sess-1");
  });

  it("reports nothing to rewind on an empty transcript (R3.6)", async () => {
    const { deps, chunks, rewindFiles } = mkDeps([]);

    await handleRewindCommand(deps, invocation({ kind: "list" }));

    expect(chunks.join("")).toMatch(/nothing to rewind/i);
    expect(rewindFiles).not.toHaveBeenCalled();
  });

  it("restores a valid checkpoint via rewindFiles with the tracked uuid (R3.3, R3.4)", async () => {
    const { deps, chunks, rewindFiles } = mkDeps(TRANSCRIPT);

    await handleRewindCommand(deps, invocation({ kind: "restore", index: 1 }));

    expect(rewindFiles).toHaveBeenCalledTimes(1);
    expect(rewindFiles).toHaveBeenCalledWith("uuid-c");
    expect(chunks.join("")).toContain("cherries");
  });

  it("rejects an out-of-range index with usage + range and no file changes (R3.5)", async () => {
    const { deps, chunks, rewindFiles } = mkDeps(TRANSCRIPT);

    await handleRewindCommand(deps, invocation({ kind: "restore", index: 99 }));

    const text = chunks.join("");
    expect(text).toContain("/rewind");
    expect(text).toContain("3"); // upper bound of the valid range
    expect(rewindFiles).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric argument with usage and no file changes (R3.5)", async () => {
    const { deps, chunks, rewindFiles } = mkDeps(TRANSCRIPT);

    await handleRewindCommand(deps, invocation({ kind: "invalid", raw: "abc" }));

    expect(chunks.join("")).toContain("/rewind");
    expect(rewindFiles).not.toHaveBeenCalled();
  });

  it("degrades to an error message when the transcript cannot be fetched", async () => {
    const { deps, chunks, rewindFiles } = mkDeps(new Error("session history unavailable"));

    await expect(
      handleRewindCommand(deps, invocation({ kind: "restore", index: 1 })),
    ).resolves.toBeUndefined();

    expect(chunks.join("").length).toBeGreaterThan(0);
    expect(rewindFiles).not.toHaveBeenCalled();
  });
});
