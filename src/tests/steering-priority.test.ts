/**
 * Task 1.2 (R1.1, R1.4) — a steered message is delivered at priority `later`
 * WHILE any permission or elicitation request is awaiting the user, and at `now`
 * otherwise.
 *
 * Authored test-first from the requirement alone. It asserts only what the wire
 * carries — the `priority` field of the message pushed into the SDK input — so it
 * describes the contract rather than whatever state the agent keeps to honour it.
 *
 * The awaiting request is real, not simulated: the client's `requestPermission` /
 * `unstable_createElicitation` are left UNRESOLVED, which is precisely the window
 * the requirement is about.
 *
 * The hostile halves, in the order the rule demands:
 *   1. WRONGLY RETURNS TO `now` — two requests open, one settles. A boolean, or a
 *      counter that resets instead of decrementing, reads "nothing pending" while
 *      the user is still being asked. (The design's own reason for a counter:
 *      parallel subagents ask concurrently.)
 *   2. WRONGLY STAYS AT `later` — every request settles, so the next steer must be
 *      `now` again. A counter that never decrements passes case 1 and fails here.
 *   3. THE THIRD SETTLEMENT — a request that settles by REJECTING. It is neither of
 *      the two above and no wording in R1.1 points at it: "awaiting user input"
 *      ends when the request ends, however it ends. A decrement placed on the
 *      success path alone leaves the session pinned at `later` for good.
 * Only then the two benign fixtures (none pending → `now`; one pending → `later`).
 */
import { describe, it, expect } from "vitest";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import { mockSessionState, userEcho, wrapQuery } from "./session-doubles.js";

const SID = "test-session";

/** A client whose permission and elicitation requests never settle on their own:
 *  each call parks a resolver the test settles by hand. */
function pendingClient(updates: unknown[] = []) {
  const permissions: Array<{
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const elicitations: Array<{ resolve: (value: unknown) => void }> = [];
  const client = {
    sessionUpdate: async (notification: unknown) => {
      updates.push(notification);
    },
    requestPermission: () =>
      new Promise((resolve, reject) => {
        permissions.push({ resolve, reject });
      }),
    unstable_createElicitation: () =>
      new Promise((resolve) => {
        elicitations.push({ resolve });
      }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as unknown as AcpClient;
  return { client, permissions, elicitations };
}

/** One live turn that captures every message pushed after the first, then ends
 *  the turn normally. The steered message is the capture that matters. */
function liveTurn(agent: ClaudeAcpAgent, captured: unknown[]) {
  const input = new Pushable<any>();
  async function* generator() {
    const iter = input[Symbol.asyncIterator]();
    const first = await iter.next();
    yield userEcho(first.value); // the turn becomes active
    const steered = await iter.next();
    captured.push(steered.value);
    yield userEcho(steered.value); // an unrelated replay — settles nothing
    yield {
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      is_error: false,
      result: "",
      errors: [],
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "result-uuid",
      session_id: SID,
    };
    yield { type: "system", subtype: "session_state_changed", state: "idle" };
  }
  agent.sessions[SID] = mockSessionState({
    query: wrapQuery(generator()),
    input,
    modes: {
      currentModeId: "plan",
      availableModes: [
        { id: "default", name: "Manual" },
        { id: "acceptEdits", name: "Accept edits" },
        { id: "plan", name: "Plan" },
      ],
    },
    models: { currentModelId: "opus", availableModels: [] },
    modelInfos: [],
    emittedToolCalls: new Set(["toolu_1", "toolu_2"]),
  });
  return input;
}

const waitFor = async (condition: () => boolean, what = "condition") => {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor timed out: ${what}`);
};

/** Ask for permission to use a tool, WITHOUT awaiting: the returned promise stays
 *  in flight for exactly as long as the client leaves the request unanswered. */
function askPermission(agent: ClaudeAcpAgent, toolUseID: string): Promise<unknown> {
  return (agent as any)
    .canUseTool(SID)(
      "ExitPlanMode",
      { plan: "do stuff" },
      {
        signal: new AbortController().signal,
        toolUseID,
      },
    )
    .catch(() => undefined);
}

/** Forward an MCP elicitation to the client, WITHOUT awaiting. */
function askElicitation(agent: ClaudeAcpAgent): Promise<unknown> {
  return (agent as any)
    .handleMcpElicitation(SID, { form: true, url: false })(
      {
        serverName: "server",
        message: "Need your name",
        mode: "form",
        requestedSchema: { properties: { name: { type: "string" } } },
      },
      { signal: new AbortController().signal },
    )
    .catch(() => undefined);
}

/** Steer the running turn and report the priority the pushed message carried. */
async function steeredPriority(agent: ClaudeAcpAgent, captured: any[]): Promise<unknown> {
  const before = captured.length;
  await agent.steer({
    sessionId: SID,
    prompt: [{ type: "text", text: "also handle X" }],
  });
  await waitFor(() => captured.length > before, "the steered message to be pushed");
  return captured[before].priority;
}

describe("steering priority while user input is pending (R1.1)", () => {
  it("stays at 'later' while a SECOND request is still awaiting the user", async () => {
    // Hostile half 1 — the collapse. Two requests are open; one settles. Anything
    // that tracks "is something pending" as a flag now says no, and the steer
    // pre-empts a dialog the user is still looking at.
    const { client, permissions } = pendingClient();
    const agent = new ClaudeAcpAgent(client, {
      log: () => {},
      error: () => {},
    });
    const captured: any[] = [];
    liveTurn(agent, captured);

    const turn = agent.prompt({
      sessionId: SID,
      prompt: [{ type: "text", text: "start" }],
    });
    await waitFor(() => !!agent.sessions[SID]?.activeTurn, "the turn to go active");

    const first = askPermission(agent, "toolu_1");
    const second = askPermission(agent, "toolu_2");
    await waitFor(() => permissions.length === 2, "both permission requests to reach the client");

    permissions[0].resolve({ outcome: { outcome: "cancelled" } });
    await first;

    expect(await steeredPriority(agent, captured)).toBe("later");

    permissions[1].resolve({ outcome: { outcome: "cancelled" } });
    await second;
    await turn;
  });

  it("returns to 'now' only once the LAST request has settled", async () => {
    // Hostile half 2 — the converse. A count that only ever grows satisfies case 1
    // and pins the session at 'later' for the rest of its life.
    const { client, permissions } = pendingClient();
    const agent = new ClaudeAcpAgent(client, {
      log: () => {},
      error: () => {},
    });
    const captured: any[] = [];
    liveTurn(agent, captured);

    const turn = agent.prompt({
      sessionId: SID,
      prompt: [{ type: "text", text: "start" }],
    });
    await waitFor(() => !!agent.sessions[SID]?.activeTurn, "the turn to go active");

    const first = askPermission(agent, "toolu_1");
    const second = askPermission(agent, "toolu_2");
    await waitFor(() => permissions.length === 2, "both permission requests to reach the client");
    permissions[0].resolve({ outcome: { outcome: "cancelled" } });
    permissions[1].resolve({ outcome: { outcome: "cancelled" } });
    await Promise.all([first, second]);

    expect(await steeredPriority(agent, captured)).toBe("now");
    await turn;
  });

  it("counts a REJECTED request as settled, not as still awaiting", async () => {
    // The third settlement. "Awaiting user input" ends when the request ends —
    // a dismissed dialog rejects, and a decrement on the success path alone never
    // runs. No wording in R1.1 names this case; it is the one the pair misses.
    const { client, permissions } = pendingClient();
    const agent = new ClaudeAcpAgent(client, {
      log: () => {},
      error: () => {},
    });
    const captured: any[] = [];
    liveTurn(agent, captured);

    const turn = agent.prompt({
      sessionId: SID,
      prompt: [{ type: "text", text: "start" }],
    });
    await waitFor(() => !!agent.sessions[SID]?.activeTurn, "the turn to go active");

    const asked = askPermission(agent, "toolu_1");
    await waitFor(() => permissions.length === 1, "the permission request to reach the client");
    permissions[0].reject(new Error("the client dismissed the dialog"));
    await asked;

    expect(await steeredPriority(agent, captured)).toBe("now");
    await turn;
  });

  it("delivers at 'later' while a permission request awaits the user", async () => {
    const { client, permissions } = pendingClient();
    const agent = new ClaudeAcpAgent(client, {
      log: () => {},
      error: () => {},
    });
    const captured: any[] = [];
    liveTurn(agent, captured);

    const turn = agent.prompt({
      sessionId: SID,
      prompt: [{ type: "text", text: "start" }],
    });
    await waitFor(() => !!agent.sessions[SID]?.activeTurn, "the turn to go active");

    const asked = askPermission(agent, "toolu_1");
    await waitFor(() => permissions.length === 1, "the permission request to reach the client");

    expect(await steeredPriority(agent, captured)).toBe("later");

    permissions[0].resolve({ outcome: { outcome: "cancelled" } });
    await asked;
    await turn;
  });

  it("delivers at 'later' while an ELICITATION awaits the user", async () => {
    // R1.1 names both kinds of request. An implementation that watches only the
    // permission path leaves the elicitation dialog interruptible.
    const { client, elicitations } = pendingClient();
    const agent = new ClaudeAcpAgent(client, {
      log: () => {},
      error: () => {},
    });
    const captured: any[] = [];
    liveTurn(agent, captured);

    const turn = agent.prompt({
      sessionId: SID,
      prompt: [{ type: "text", text: "start" }],
    });
    await waitFor(() => !!agent.sessions[SID]?.activeTurn, "the turn to go active");

    const asked = askElicitation(agent);
    await waitFor(() => elicitations.length === 1, "the elicitation to reach the client");

    expect(await steeredPriority(agent, captured)).toBe("later");

    elicitations[0].resolve({ outcome: "cancelled" });
    await asked;
    await turn;
  });

  it("delivers at 'now' when nothing is awaiting the user", async () => {
    const { client } = pendingClient();
    const agent = new ClaudeAcpAgent(client, {
      log: () => {},
      error: () => {},
    });
    const captured: any[] = [];
    liveTurn(agent, captured);

    const turn = agent.prompt({
      sessionId: SID,
      prompt: [{ type: "text", text: "start" }],
    });
    await waitFor(() => !!agent.sessions[SID]?.activeTurn, "the turn to go active");

    expect(await steeredPriority(agent, captured)).toBe("now");
    await turn;
  });
});
