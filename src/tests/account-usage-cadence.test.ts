import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, quotaPollIntervalMs, type AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import { NO_PLAN_RATE_LIMITS } from "./helpers.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/**
 * Story 002, sub-task 1.4 — when the structured usage report is asked for.
 *
 * Contract (R1.1, R1.2, R1.7, R1.8): the report is requested once when the
 * session is established, so the bars are born filled rather than waiting for a
 * push that may never come, and once again at the end of each turn, which is
 * when consumption actually changed.
 *
 * A third moment was added later: an idle refresh on a timer. The two borders
 * above are both *consumption* events, and none of them is *time* — so a window
 * that resets while nobody is prompting kept showing the old utilization until
 * somebody sent a prompt. The tick stands down while a turn is in flight (that
 * turn's own end already refreshes) and dies with the query stream. A failed request leaves the session
 * running and reports nothing, and the live `rate_limit_event` forwarding — the
 * only source of a MEASURED status — keeps working alongside the new one.
 *
 * The SDK method is `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`
 * (sdk.d.ts). The name is deliberately awful and deliberately pinned here: it
 * is the only name the real `Query` answers to, and a rename must fail loudly
 * rather than degrade to no report at all.
 */

const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const SESSION_ID = "test-session";

/** The measured status a live `rate_limit_event` carries — a different window
 *  kind from the report fixture below, so the two payloads can never be
 *  confused for one another. */
const LIVE_RATE_LIMIT_INFO = {
  status: "rejected" as const,
  rateLimitType: "five_hour" as const,
  resetsAt: 1788436800,
  utilization: 0.9,
};

/** A report carrying exactly one window, at 42% of a weekly budget. */
function weeklyReport() {
  return {
    ...NO_PLAN_RATE_LIMITS,
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: { seven_day: { utilization: 42, resets_at: null } },
  };
}

/** Every `_meta["_claude/rateLimit"]` payload the client was sent. */
function quotaPayloads(notifications: SessionNotification[]): Record<string, unknown>[] {
  return notifications
    .map((notification) => (notification.update as Record<string, any>)?._meta)
    .map((meta) => meta?.["_claude/rateLimit"])
    .filter((payload): payload is Record<string, unknown> => Boolean(payload));
}

/** An assistant frame carrying usage, so the agent has a context total to
 *  attach to a subsequent notification. */
function assistantMessage() {
  return {
    type: "assistant",
    uuid: randomUUID(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      id: "msg-account-usage",
      model: "claude-sonnet-4-6",
      role: "assistant",
      type: "message",
      stop_reason: null,
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const { makeMockQuery } = await import("./helpers.js");
  return {
    ...actual,
    query: () =>
      makeMockQuery({
        // A catalog with at least one model: `createSession` reads the current
        // model off it, so an empty one crashes before any usage request.
        initializationResult: async () => ({
          models: [
            {
              value: "claude-sonnet-4-6",
              displayName: "Claude Sonnet",
              description: "Balanced",
              supportsAutoMode: true,
            },
          ],
        }),
        [USAGE_METHOD]: () => sessionStartUsage(),
      }),
  };
});

vi.mock("../tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools.js")>();
  return { ...actual, registerHookCallback: vi.fn() };
});

let sessionStartUsage: () => Promise<unknown>;

describe("the structured usage report is requested at both borders, and while idle", () => {
  let notifications: SessionNotification[];
  let agent: ClaudeAcpAgent;

  function createMockClient(): AcpClient {
    return {
      sessionUpdate: async (notification: SessionNotification) => {
        notifications.push(notification);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
  }

  /** One turn: echo the pushed prompt, emit `extra` frames, succeed, go idle. */
  async function* oneTurn(input: Pushable<any>, extra: unknown[] = []) {
    const iterator = input[Symbol.asyncIterator]();
    const { value: userMessage } = await iterator.next();
    yield userEcho(userMessage);
    for (const message of extra) {
      yield message;
    }
    yield successfulResultMessage();
    yield { type: "system", subtype: "session_state_changed", state: "idle" };
  }

  /** Like `oneTurn`, but the stream stays OPEN afterwards, which is what the real
   *  long-lived consumer sees: it forwards background and between-turn output,
   *  so its query does not end when a turn does. The idle refresh lives entirely
   *  in that window, so a double that ends the stream closes the gap under test
   *  and would let a broken timer pass. */
  async function* turnsThenIdle(input: Pushable<any>, extra: unknown[] = []) {
    for await (const userMessage of input) {
      yield userEcho(userMessage);
      for (const message of extra) {
        yield message;
      }
      yield successfulResultMessage();
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
  }

  /** Install a session whose stream outlives the turn (see `turnsThenIdle`). */
  function installLiveSession(usage: ReturnType<typeof vi.fn>, extra: unknown[] = []) {
    const input = new Pushable<any>();
    const query = Object.assign(wrapQuery(turnsThenIdle(input, extra)), {
      [USAGE_METHOD]: usage,
    });
    agent.sessions[SESSION_ID] = mockSessionState({ query, input }, agent);
    return input;
  }

  /** Install a session whose `Query` answers the usage request with `usage`. */
  function installSession(usage: ReturnType<typeof vi.fn>, extra: unknown[] = []) {
    const input = new Pushable<any>();
    const query = Object.assign(wrapQuery(oneTurn(input, extra)), { [USAGE_METHOD]: usage });
    agent.sessions[SESSION_ID] = mockSessionState({ query, input }, agent);
    return input;
  }

  /** A turn against a live stream. Unlike `runTurn` this does NOT await the
   *  consumer: a long-lived consumer only settles when the stream ends, so
   *  awaiting it here would hang. The prompt resolving is the turn ending; the
   *  refresh that follows is picked up with `waitFor`. */
  async function runTurnLive() {
    return agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "hello" }],
    });
  }

  async function runTurn() {
    const response = await agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "hello" }],
    });
    await agent.sessions[SESSION_ID]?.consumer;
    return response;
  }

  beforeEach(() => {
    notifications = [];
    sessionStartUsage = async () => weeklyReport();
    agent = new ClaudeAcpAgent(createMockClient(), { log: () => {}, error: () => {} });
  });

  it("issues exactly one request when the session is established (R1.1)", async () => {
    const usage = vi.fn(async () => weeklyReport());
    sessionStartUsage = usage;

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    // Waited for rather than asserted outright: the request may be issued
    // without blocking `session/new`, which R1.1 permits — it only forbids the
    // first prompt being answered before the report was asked for.
    await vi.waitFor(() => expect(usage).toHaveBeenCalled());
    expect(usage).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one request when a turn ends (R1.2)", async () => {
    const usage = vi.fn(async () => weeklyReport());
    installSession(usage);

    await runTurn();

    await vi.waitFor(() => expect(usage).toHaveBeenCalled());
    expect(usage).toHaveBeenCalledTimes(1);
    // The report was not merely fetched: its window reached the client, on the
    // 0..1 scale (R1.3).
    expect(quotaPayloads(notifications)).toContainEqual(
      expect.objectContaining({ rateLimitType: "seven_day", utilization: 0.42 }),
    );
  });

  it("survives a rejected request without emitting or throwing (R1.7)", async () => {
    const usage = vi.fn(async () => {
      throw new Error("get_usage is experimental and just changed shape");
    });
    installSession(usage);

    const response = await runTurn();

    // The request has to have been ISSUED for its failure to mean anything —
    // an adapter that never calls it also never emits and never throws.
    await vi.waitFor(() => expect(usage).toHaveBeenCalled());
    expect(response.stopReason).toBe("end_turn");
    expect(quotaPayloads(notifications)).toEqual([]);
  });

  it("keeps forwarding a live rate-limit event verbatim beside the derived windows (R1.8)", async () => {
    const usage = vi.fn(async () => weeklyReport());
    installSession(usage, [
      assistantMessage(),
      {
        type: "rate_limit_event",
        rate_limit_info: LIVE_RATE_LIMIT_INFO,
        uuid: randomUUID(),
        session_id: SESSION_ID,
      },
    ]);

    await runTurn();

    const payloads = quotaPayloads(notifications);
    // The measured payload passes through untouched: it is the only source of a
    // `rejected` status, and `0011` ranks by status before utilization.
    const measured = payloads.filter(
      (payload) => JSON.stringify(payload) === JSON.stringify(LIVE_RATE_LIMIT_INFO),
    );
    expect(measured).toHaveLength(1);

    // …and it did not REPLACE the derived windows, nor they it: the two sources
    // coexist and stay distinguishable.
    const derived = payloads.filter((payload) => payload.rateLimitType === "seven_day");
    expect(derived).toHaveLength(1);
    expect(derived[0]).toEqual(expect.objectContaining({ utilization: 0.42 }));
  });

  it("asks for the plan limits without the transcript scan", async () => {
    const usage = vi.fn(async () => weeklyReport());
    installSession(usage);

    await runTurn();

    await vi.waitFor(() => expect(usage).toHaveBeenCalled());
    // Nothing on this path reads `behaviors`, and filling it costs a scan of
    // every local transcript. Pinned as an argument rather than left to a
    // default so the cost cannot come back silently.
    expect(usage).toHaveBeenCalledWith({ skipBehaviors: true });
  });

  it("refreshes again while idle, with no turn to carry it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const usage = vi.fn(async () => weeklyReport());
      installLiveSession(usage);

      await runTurnLive();
      await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(1));

      // The whole point: no prompt is sent between here and the assertion.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(usage).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(usage).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops refreshing once the session's stream is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const usage = vi.fn(async () => weeklyReport());
      installLiveSession(usage);

      await runTurnLive();
      await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(1));

      // Proves it was ticking BEFORE the close, so the assertion after it means
      // "stopped" rather than "never started".
      await vi.advanceTimersByTimeAsync(60_000);
      expect(usage).toHaveBeenCalledTimes(2);

      await agent.closeSession({ sessionId: SESSION_ID });
      const afterClose = usage.mock.calls.length;

      // A timer that outlives its stream does not fail loudly — it just asks a
      // dead session for a report once a minute, forever.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(usage).toHaveBeenCalledTimes(afterClose);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the idle refresh interval is read from the environment", () => {
  it("defaults when unset or empty", () => {
    expect(quotaPollIntervalMs(undefined)).toBe(60_000);
    expect(quotaPollIntervalMs("   ")).toBe(60_000);
  });

  it("treats exactly 0 as off, because that is the only way to ask", () => {
    expect(quotaPollIntervalMs("0")).toBe(0);
  });

  it("raises anything under the floor rather than honouring it", () => {
    // Each tick is a control request, and neither window moves fast enough for
    // a tighter loop to show something a 15-second one would miss.
    expect(quotaPollIntervalMs("1")).toBe(15_000);
    expect(quotaPollIntervalMs("30000")).toBe(30_000);
  });

  it("falls back to the default on garbage, never to off", () => {
    // A typo must not silently restore the stale-bars behaviour this exists to
    // fix; only an explicit 0 may do that.
    expect(quotaPollIntervalMs("banana")).toBe(60_000);
    expect(quotaPollIntervalMs("-5")).toBe(60_000);
  });
});
