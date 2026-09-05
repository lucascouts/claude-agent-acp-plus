import { describe, it, expect, vi } from "vitest";
import { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  CONTEXT_COMPACTION_META_KEY,
  CONTEXT_COMPACTION_META_VERSION,
  createContextCompactionMeta,
} from "../context-compaction-meta.js";
import {
  ContextCompactionLifecycle,
  contextCompactionMetadataFromBoundary,
} from "../context-compaction.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/**
 * R2.1 / R2.2 - compaction is reported as one ACP tool lifecycle carrying a
 * versioned `_meta.contextCompaction`, and the `compactionInProgress` inference
 * that used to report it is gone rather than left inert.
 *
 * The load-bearing case is duplicate-terminal, in both converse directions:
 *   - two terminal signals for ONE compaction must not become two reports
 *     (wrongly split);
 *   - two genuinely separate compactions in one turn must not collapse into one
 *     (wrongly collapsed).
 * A suite that only checked the benign single-compaction case would stay green
 * against a fix that satisfies either converse by violating the other.
 */

type Update = Record<string, any>;

function capture() {
  const updates: Update[] = [];
  const sendUpdate = vi.fn(async (notification: SessionNotification) => {
    updates.push(notification.update as unknown as Update);
  });
  return { updates, sendUpdate };
}

function isToolUpdate(update: Update): boolean {
  return update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update";
}

describe("context compaction metadata", () => {
  it("carries a schema version under its own _meta key", () => {
    // D3: the downstream patch reads the version and degrades on any value it
    // does not know. A payload without one cannot be degraded from.
    const meta = createContextCompactionMeta({ trigger: "manual", preTokens: 180_000 });

    expect(Object.keys(meta)).toEqual([CONTEXT_COMPACTION_META_KEY]);
    expect(CONTEXT_COMPACTION_META_KEY).toBe("contextCompaction");
    expect(typeof CONTEXT_COMPACTION_META_VERSION).toBe("number");
    expect(CONTEXT_COMPACTION_META_VERSION).toBeGreaterThanOrEqual(1);
    expect(meta[CONTEXT_COMPACTION_META_KEY]).toMatchObject({
      version: CONTEXT_COMPACTION_META_VERSION,
      trigger: "manual",
      preTokens: 180_000,
    });
  });

  it("maps a compact boundary onto provider-neutral names", () => {
    expect(
      contextCompactionMetadataFromBoundary({
        trigger: "auto",
        pre_tokens: 180_000,
        post_tokens: 12_345,
        duration_ms: 2_500,
      }),
    ).toEqual({
      trigger: "automatic",
      preTokens: 180_000,
      postTokens: 12_345,
      durationMs: 2_500,
    });
  });

  it("omits boundary fields an older SDK frame does not carry", () => {
    expect(contextCompactionMetadataFromBoundary({ trigger: "manual", pre_tokens: 42 })).toEqual({
      trigger: "manual",
      preTokens: 42,
    });
  });
});

describe("ContextCompactionLifecycle - one shape per event", () => {
  it("status 'compacting' opens the tool call the client renders", async () => {
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-start");

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "compact-start",
      title: "Compact conversation",
      kind: "think",
      status: "in_progress",
      _meta: { [CONTEXT_COMPACTION_META_KEY]: { version: CONTEXT_COMPACTION_META_VERSION } },
    });
    expect(lifecycle.hasDeliveredOutput).toBe(true);
  });

  it("stream heartbeats update the open call once and never leak the summary", async () => {
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-delta-1");
    await lifecycle.heartbeat("test-session", "compact-delta-1");
    await lifecycle.heartbeat("test-session", "compact-delta-2");

    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "compact-delta-1",
      status: "in_progress",
    });
    // The generated summary is internal to the agent; nothing about it reaches
    // the client through this lane.
    expect(JSON.stringify(updates)).not.toContain("summary");
  });

  it("a terminal-only result still produces one completed tool call", async () => {
    // The SDK omits the opening status on replay, so the terminal signal has to
    // be able to stand alone rather than be dropped for lack of a start.
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.finish("test-session", "compact-result", "completed");

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "compact-result",
      title: "Compact conversation",
      kind: "think",
      status: "completed",
    });
  });

  it("a failure carries its reason on the same lifecycle", async () => {
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-start");
    await lifecycle.finish("test-session", "compact-start", "failed", {
      error: "summary rejected",
    });

    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "compact-start",
      status: "failed",
      _meta: {
        [CONTEXT_COMPACTION_META_KEY]: {
          version: CONTEXT_COMPACTION_META_VERSION,
          error: "summary rejected",
        },
      },
    });
    // Claude also emits that error as local-command stdout; the duplicate is
    // consumed once, and only when it is the same text.
    expect(lifecycle.consumeDuplicateErrorOutput("summary rejected")).toBe(true);
    expect(lifecycle.consumeDuplicateErrorOutput("summary rejected")).toBe(false);
    expect(lifecycle.consumeDuplicateErrorOutput("additional diagnostic")).toBe(false);
  });

  it("HOSTILE - two terminal signals for one compaction stay one report", async () => {
    // The SDK duplicates terminal compact_result messages. One compaction is one
    // lifecycle: the second terminal must change nothing the client can see.
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-start");
    await lifecycle.finish("test-session", "compact-start", "failed", {
      error: "summary rejected",
    });
    await lifecycle.finish("test-session", "compact-start", "failed", {
      error: "summary rejected",
    });

    expect(updates.filter(isToolUpdate)).toHaveLength(2);
    expect(updates.filter((update) => update.status === "failed")).toHaveLength(1);
  });

  it("HOSTILE (converse) - two compactions in one turn stay two reports", async () => {
    // The converse defect: a rule that suppressed the second terminal by
    // identity would also swallow a genuine second compaction. The two must stay
    // distinguishable - different tool call ids, one terminal each.
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "compact-start-1");
    await lifecycle.finish("test-session", "compact-start-1", "completed");
    await lifecycle.start("test-session", "compact-start-2");
    await lifecycle.finish("test-session", "compact-start-2", "completed");

    const ids = updates.filter(isToolUpdate).map((update) => update.toolCallId);
    expect(new Set(ids).size).toBe(2);
    expect(updates.filter((update) => update.status === "completed")).toHaveLength(2);
  });

  it("reset returns the lifecycle to its unstarted state between turns", async () => {
    const { updates, sendUpdate } = capture();
    const lifecycle = new ContextCompactionLifecycle(sendUpdate);

    await lifecycle.start("test-session", "turn-1-compaction");
    await lifecycle.finish("test-session", "turn-1-compaction", "completed");
    lifecycle.reset();
    expect(lifecycle.hasDeliveredOutput).toBe(false);

    await lifecycle.start("test-session", "turn-2-compaction");
    expect(updates.at(-1)).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "turn-2-compaction",
      status: "in_progress",
    });
  });
});

describe("the agent reports one compaction once", () => {
  function runTurn(messages: any[]) {
    const updates: SessionNotification[] = [];
    const agent = new ClaudeAcpAgent(
      {
        sessionUpdate: async (notification: SessionNotification) => {
          updates.push(notification);
        },
      } as unknown as AcpClient,
      { log: () => {}, error: () => {} },
    );

    const input = new Pushable<any>();
    async function* generator() {
      const user = await input[Symbol.asyncIterator]().next();
      yield userEcho(user.value);
      yield* messages;
      yield successfulResultMessage();
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
    agent.sessions["test-session"] = mockSessionState({ query: wrapQuery(generator()), input });

    return {
      updates,
      prompt: () =>
        agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "/compact" }] }),
    };
  }

  const compactingStatus = {
    type: "system",
    subtype: "status",
    status: "compacting",
    uuid: "compact-start",
    session_id: "test-session",
  };

  const compactSucceeded = {
    type: "system",
    subtype: "status",
    status: null,
    compact_result: "success",
    uuid: "compact-done",
    session_id: "test-session",
  };

  function toolUpdates(updates: SessionNotification[]) {
    return updates.map((update) => update.update as unknown as Update).filter(isToolUpdate);
  }

  function chunkTexts(updates: SessionNotification[]) {
    return updates
      .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
      .map((update) => (update.update as any).content.text as string);
  }

  it("emits the tool lifecycle rather than the inferred text banner", async () => {
    const { updates, prompt } = runTurn([compactingStatus, compactSucceeded]);

    await prompt();

    expect(toolUpdates(updates)[0]).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "compact-start",
      title: "Compact conversation",
      kind: "think",
      status: "in_progress",
      _meta: { [CONTEXT_COMPACTION_META_KEY]: { version: CONTEXT_COMPACTION_META_VERSION } },
    });
    // R2.2: the `compactionInProgress` inference is removed, not left inert, so
    // none of its banners can reach the client alongside the lifecycle.
    expect(chunkTexts(updates).join("\n")).not.toMatch(/Compacting/);
  });

  it("HOSTILE - a duplicated terminal does not become a second report", async () => {
    // The double-report R2.2 forbids: the lifecycle reports the outcome, and a
    // surviving inference (or an unguarded duplicate) would report it again.
    const { updates, prompt } = runTurn([
      compactingStatus,
      compactSucceeded,
      { ...compactSucceeded, uuid: "compact-done-duplicate" },
    ]);

    await prompt();

    const terminal = toolUpdates(updates).filter((update) => update.status === "completed");
    expect(terminal).toHaveLength(1);
    expect(toolUpdates(updates)).toHaveLength(2);
    expect(chunkTexts(updates).join("\n")).not.toMatch(/Compacting/);
  });
});
