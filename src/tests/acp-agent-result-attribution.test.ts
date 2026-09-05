/**
 * R2.5 — a result carrying `user_message_uuid` is joined to its turn BY THAT
 * KEY; where the key is absent the existing heuristic still decides.
 *
 * Pre-authored for sub-task 4.1 (story 009). Written from the requirement, not
 * from an implementation.
 *
 * Today an echo-less result is attributed by draining the OLDEST pending
 * orphan entry — the fork's own comment calls it "dup-over-loss: prefer one
 * wrong skip over misattributing a dead turn's outcome to a live prompt". The
 * skip it prefers is not free: the entry it burns may not be the one this
 * result names, and the survivor then eats the NEXT live turn's result. SDK
 * 0.3.246+ stamps `user_message_uuid` on the result, which settles the
 * question exactly.
 *
 * The two hostile cases below are the ones the heuristic gets wrong. Both are
 * about a result reaching the WRONG turn:
 *   - it consumes an entry the result does not name (case 1), leaving the
 *     named one behind to swallow a later live turn;
 *   - it treats a live turn's stamped result as an already-covered orphan's
 *     (case 2), so the live turn never gets its outcome at all.
 * The two benign cases pin the fallback (R2.5's second half): with no stamp,
 * nothing changes.
 *
 * R2.6: nothing here touches per-model effort — that half of upstream
 * `a04d354` is explicitly out of scope.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import { mockSessionState, userEcho, wrapQuery } from "./session-doubles.js";

const SESSION_ID = "test-session";

/** A `system`/init frame advertising msg_lifecycle_v1, so cancel() routes
 *  orphan accounting through the per-uuid `orphanCommands` map. */
const lifecycleInit = {
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1"],
};

function lifecycleFrame(commandUuid: string, state: string) {
  return {
    type: "command_lifecycle",
    command_uuid: commandUuid,
    state,
    uuid: randomUUID(),
    session_id: SESSION_ID,
  };
}

const idle = { type: "system", subtype: "session_state_changed", state: "idle" };

const compacting = {
  type: "system",
  subtype: "status",
  status: "compacting",
  session_id: SESSION_ID,
};

/** A terminal result. `user_message_uuid` is the SDK's exact join key: the
 *  uuid of the user message whose prompt this turn ran. */
function resultMessage(
  overrides: {
    subtype?: "success" | "error_during_execution";
    stop_reason?: string | null;
    is_error?: boolean;
    inputTokens?: number;
    user_message_uuid?: string;
  } = {},
) {
  return {
    type: "result" as const,
    subtype: overrides.subtype ?? "success",
    stop_reason: overrides.stop_reason ?? "end_turn",
    is_error: overrides.is_error ?? false,
    result: "",
    errors: [],
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: overrides.inputTokens ?? 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: SESSION_ID,
    ...(overrides.user_message_uuid !== undefined && {
      user_message_uuid: overrides.user_message_uuid,
    }),
  };
}

function createMockAgent() {
  const client = { sessionUpdate: async () => {} } as unknown as AcpClient;
  return new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
}

function injectGeneratorSession(
  agent: ClaudeAcpAgent,
  makeGenerator: (input: Pushable<any>) => AsyncGenerator<any>,
) {
  const input = new Pushable<any>();
  (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID] = mockSessionState({
    query: wrapQuery(makeGenerator(input)),
    input,
  });
  return input;
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("waitFor timed out");
};

function session(agent: ClaudeAcpAgent) {
  return (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
}

/** Outcome of a prompt, whichever way it ends, with the rejection captured so
 *  a swallowed turn surfaces as an assertion rather than an unhandled
 *  rejection. */
function outcome(promise: Promise<any>) {
  return promise.then(
    (value) => ({ settled: true as const, value }),
    (error) => ({ settled: false as const, error: String(error) }),
  );
}

describe("R2.5 — results join their turn by user_message_uuid", () => {
  it("consumes the orphan the result NAMES, not the oldest one waiting", async () => {
    // Two prompts are cancelled while queued, so two orphan entries wait with
    // no dispatch frame seen (`pending`). Only the SECOND of them actually
    // ran, and its result says so: it is stamped with that send's uuid.
    //
    // The oldest-pending heuristic burns the FIRST entry instead and leaves
    // the named one behind — where it goes on to swallow the next live turn's
    // echo-less result. The stamp is the whole point: the result names the
    // send it answers.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inspected!: () => void;
    const afterOrphanResult = new Promise<void>((r) => (inspected = r));
    const uuids: Record<string, string> = {};

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // queued, cancelled below — never ran
        const u3 = await iter.next(); // queued, cancelled below — DID run
        uuids.second = u2.value.uuid;
        uuids.third = u3.value.uuid;
        await gate;
        yield idle; // turn 1 settles cancelled
        // The dead third turn's result, stamped with its own send's uuid.
        yield resultMessage({ inputTokens: 999, user_message_uuid: u3.value.uuid });
        await afterOrphanResult;
        const u4 = await iter.next(); // /compact — echo-less, live
        yield compacting;
        yield resultMessage({ inputTokens: 10, user_message_uuid: u4.value.uuid });
        yield idle;
      }
      return messageGenerator();
    });

    const first = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "first" }] }),
    );
    await waitFor(() => !!session(agent)?.activeTurn);
    await waitFor(() => !!session(agent)?.msgLifecycleV1);
    const second = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "second" }] }),
    );
    const third = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "third" }] }),
    );
    await waitFor(() => (session(agent)?.turnQueue?.length ?? 0) >= 3);

    await agent.cancel({ sessionId: SESSION_ID });
    expect(session(agent)?.orphanCommands?.size).toBe(2);

    const compact = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "/compact" }] }),
    );
    release();

    // One entry consumed by the stamped result. WHICH one is the requirement.
    await waitFor(() => (session(agent)?.orphanCommands?.size ?? 2) === 1);
    expect([...session(agent).orphanCommands.keys()]).toEqual([uuids.second]);
    inspected();

    // And the consequence of getting it right: the named entry is gone, so
    // /compact's own echo-less result reaches /compact.
    const compactOutcome = await compact;
    expect(compactOutcome).toMatchObject({ settled: true });
    expect((compactOutcome as { value: any }).value.stopReason).toBe("end_turn");
    expect((compactOutcome as { value: any }).value.usage?.inputTokens).toBe(10);

    await first;
    await second;
    await third;
    await session(agent)?.consumer;
  });

  it("does not read a live turn's stamped failure as an already-covered orphan's", async () => {
    // The converse collapse: an orphan was dispatched (`started`) and its own
    // terminal frame never arrived, so the entry lingers. The next echo-less
    // result belongs to a LIVE turn and says so — it is stamped with that
    // turn's send. Treating it as the lingering orphan's shared result
    // swallows it, and the live prompt never learns its outcome.
    //
    // The result here is a FAILURE: the case the requirement cares about most,
    // since a swallowed failure is a turn that reports nothing at all.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // queued, cancelled below
        await gate;
        yield idle; // turn 1 settles cancelled
        yield lifecycleFrame(u2.value.uuid, "started"); // dispatched; no terminal frame ever comes
        const u3 = await iter.next(); // /compact — echo-less, live
        yield compacting;
        // The LIVE turn's own failure, stamped with the live send's uuid.
        yield resultMessage({
          subtype: "error_during_execution",
          stop_reason: null,
          is_error: true,
          inputTokens: 10,
          user_message_uuid: u3.value.uuid,
        });
        yield idle;
      }
      return messageGenerator();
    });

    const first = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "first" }] }),
    );
    await waitFor(() => !!session(agent)?.activeTurn);
    await waitFor(() => !!session(agent)?.msgLifecycleV1);
    const second = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "second" }] }),
    );
    await waitFor(() => (session(agent)?.turnQueue?.length ?? 0) >= 2);

    await agent.cancel({ sessionId: SESSION_ID });
    const compact = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "/compact" }] }),
    );
    release();

    const compactOutcome = await compact;
    // The stamped failure reached its own turn: the prompt ends in that
    // failure. What it must NOT do is end in the stream-ended rejection a
    // swallowed result leaves behind — a turn nobody ever attributed anything
    // to.
    expect(
      JSON.stringify(compactOutcome),
      "the live turn's stamped failure must reach it, not be eaten as an orphan's",
    ).not.toMatch(/session ended|Session ended|start a new session/i);

    await first;
    await second;
    await session(agent)?.consumer;
  });
});

describe("R2.5 — with no stamp, the existing heuristic still decides", () => {
  it("skips an unstamped orphan result and settles the live turn on its own", async () => {
    // The fallback, unchanged: older producers send no `user_message_uuid`, so
    // the pending-orphan skip is still what keeps the dead turn's 999 tokens
    // off the live /compact.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        await iter.next(); // queued, cancelled below
        await gate;
        yield idle; // turn 1 settles cancelled
        yield resultMessage({ inputTokens: 999 }); // the dead turn's result — UNSTAMPED
        await iter.next(); // /compact
        yield compacting;
        yield resultMessage({ inputTokens: 10 }); // UNSTAMPED
        yield idle;
      }
      return messageGenerator();
    });

    const first = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "first" }] }),
    );
    await waitFor(() => !!session(agent)?.activeTurn);
    await waitFor(() => !!session(agent)?.msgLifecycleV1);
    const second = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "second" }] }),
    );
    await waitFor(() => (session(agent)?.turnQueue?.length ?? 0) >= 2);

    await agent.cancel({ sessionId: SESSION_ID });
    const compact = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "/compact" }] }),
    );
    release();

    const compactOutcome = await compact;
    expect(compactOutcome).toMatchObject({ settled: true });
    expect((compactOutcome as { value: any }).value.stopReason).toBe("end_turn");
    expect((compactOutcome as { value: any }).value.usage?.inputTokens).toBe(10);

    await first;
    await second;
    await session(agent)?.consumer;
  });

  it("still refuses to promote a stamped orphan's result onto a live turn", async () => {
    // The join must not become a promotion: a result stamped with a CANCELLED
    // send's uuid is that dead turn's, and the live /compact queued behind it
    // must keep its own outcome and its own tokens.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // queued, cancelled below
        await gate;
        yield idle; // turn 1 settles cancelled
        yield resultMessage({ inputTokens: 999, user_message_uuid: u2.value.uuid });
        const u3 = await iter.next(); // /compact
        yield compacting;
        yield resultMessage({ inputTokens: 10, user_message_uuid: u3.value.uuid });
        yield idle;
      }
      return messageGenerator();
    });

    const first = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "first" }] }),
    );
    await waitFor(() => !!session(agent)?.activeTurn);
    await waitFor(() => !!session(agent)?.msgLifecycleV1);
    const second = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "second" }] }),
    );
    await waitFor(() => (session(agent)?.turnQueue?.length ?? 0) >= 2);

    await agent.cancel({ sessionId: SESSION_ID });
    const compact = outcome(
      agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "/compact" }] }),
    );
    release();

    const compactOutcome = await compact;
    expect(compactOutcome).toMatchObject({ settled: true });
    expect((compactOutcome as { value: any }).value.stopReason).toBe("end_turn");
    // 999 would mean the dead turn's result was promoted onto /compact.
    expect((compactOutcome as { value: any }).value.usage?.inputTokens).toBe(10);

    await first;
    await second;
    await session(agent)?.consumer;
  });
});
