/**
 * R6 — the account is a property of the session.
 *
 * Pre-authored for sub-task 4.2 (story 009). Written from the requirement, not
 * from an implementation: every assertion is about what the adapter must
 * ADVERTISE and APPLY, never about how it builds it.
 *
 * Contract, from story 005's preserved design (D1, D2, D4, D8) and story 009's D9:
 *  - accounts are DECLARED in the agent's settings block, each entry a display
 *    name and a configuration directory (D4) — never discovered by globbing;
 *  - the selector is one more `type: "select"` option in the list
 *    `buildConfigOptions` already returns, with id `account` (D1);
 *  - selecting one applies it through the per-session `env` the SDK already
 *    accepts (`CLAUDE_CONFIG_DIR`), with no second agent entry (D2, D9);
 *  - below two declared accounts the option is not offered at all (D8);
 *  - nothing credential-shaped travels over the wire (R6.4).
 *
 * The declared list arrives through the settings parameter because D4 puts it
 * in the settings block; if the implementation widens a different parameter,
 * only `optionsFor` below moves.
 */

import { describe, it, expect, vi } from "vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { buildConfigOptions, ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { makeMockQuery } from "./helpers.js";

const SESSION_ID = "test-session";
const ACCOUNT_CONFIG_ID = "account";

/** Two declared accounts: a display name and a configuration directory each. */
const WORK = { name: "work", configDir: "/home/u/.claude-work" };
const PERSONAL = { name: "personal", configDir: "/home/u/.claude-personal" };

const MOCK_MODES = {
  currentModeId: "default",
  availableModes: [{ id: "default", name: "Default", description: "Standard behavior" }],
};

const MOCK_MODELS = {
  currentModelId: "claude-opus-4-5",
  availableModels: [
    { modelId: "claude-opus-4-5", name: "Claude Opus", description: "Most capable" },
    { modelId: "claude-sonnet-4-6", name: "Claude Sonnet", description: "Balanced" },
  ],
};

const MODEL_INFOS: ModelInfo[] = MOCK_MODELS.availableModels.map((m) => ({
  value: m.modelId,
  displayName: m.name,
  description: m.description,
  supportsEffort: false,
  supportedEffortLevels: [],
}));

/** The advertised session configuration options for a given declared list. */
function optionsFor(
  accounts: Array<{ name: string; configDir: string }>,
  currentAccount?: string,
): Array<Record<string, any>> {
  return (buildConfigOptions as unknown as (...args: unknown[]) => Array<Record<string, any>>)(
    MOCK_MODES,
    MOCK_MODELS,
    MODEL_INFOS,
    undefined,
    [],
    "default",
    undefined,
    undefined,
    undefined,
    { disableWorkflows: false, accounts, currentAccount },
  );
}

function accountOption(options: Array<Record<string, any>>) {
  return options.find((o) => o.id === ACCOUNT_CONFIG_ID);
}

describe("R6.1 — the selector appears where more than one account is declared", () => {
  it("advertises an account selector naming every declared account", () => {
    const option = accountOption(optionsFor([WORK, PERSONAL], WORK.name));

    expect(option).toBeDefined();
    expect(option!.type).toBe("select");
    // Every declared account is offered, and the one in force is the current value.
    const values = (option!.options as Array<Record<string, any>>).map((o) => o.value);
    expect(values).toHaveLength(2);
    expect(new Set(values)).toEqual(new Set([WORK.name, PERSONAL.name]));
    expect(option!.currentValue).toBe(WORK.name);
  });

  it("keeps two same-named declarations distinguishable rather than collapsing them", () => {
    // Hostile half of the identity rule: two accounts that a name-keyed
    // selector would merge into one row denote DIFFERENT credential homes and
    // must stay apart — a user who picks one must not silently get the other.
    const twinA = { name: "work", configDir: "/home/u/.claude-work-a" };
    const twinB = { name: "work", configDir: "/home/u/.claude-work-b" };

    const option = accountOption(optionsFor([twinA, twinB], undefined));

    expect(option).toBeDefined();
    const entries = option!.options as Array<Record<string, any>>;
    expect(entries).toHaveLength(2);
    // Two entries, two distinct selectable values: whatever the adapter
    // renders, one choice must never denote both homes.
    expect(new Set(entries.map((e) => e.value)).size).toBe(2);
  });
});

describe("R6.2 — the selector is not offered below two accounts", () => {
  it("omits it when no account is declared", () => {
    expect(accountOption(optionsFor([]))).toBeUndefined();
  });

  it("omits it when exactly one account is declared", () => {
    // A one-entry selector occupies a menu row to say nothing (D8).
    expect(accountOption(optionsFor([WORK], WORK.name))).toBeUndefined();
  });
});

describe("R6.3 — selecting an account applies it to the session", () => {
  function createAgent() {
    const notifications: Array<Record<string, any>> = [];
    const client = {
      sessionUpdate: async (n: Record<string, any>) => {
        notifications.push(n);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;

    const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
    const createSessionSpy = vi.fn(async () => ({
      sessionId: SESSION_ID,
      modes: MOCK_MODES,
      models: MOCK_MODELS,
      configOptions: [],
    }));
    (agent as unknown as { createSession: unknown }).createSession = createSessionSpy;

    (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID] = {
      query: makeMockQuery(),
      input: null,
      cancelled: false,
      cwd: "/test",
      permissionMode: "default",
      settingsManager: { getSettings: () => ({ accounts: [WORK, PERSONAL] }) },
      declaredAccounts: [WORK, PERSONAL],
      currentAccount: WORK.name,
      modes: structuredClone(MOCK_MODES),
      models: structuredClone(MOCK_MODELS),
      modelInfos: MODEL_INFOS,
      agents: [],
      currentAgent: "default",
      configOptions: optionsFor([WORK, PERSONAL], WORK.name),
      contextWindowSize: 200000,
      toolUseCache: {},
      emittedToolCalls: new Set(),
    };

    return { agent, notifications, createSessionSpy };
  }

  /** Every environment the adapter applied for this session, wherever it
   *  recorded it — the requirement is that the account reaches the SDK's
   *  per-session `env`, not that it is stored under a particular field. */
  function appliedEnvs(agent: ClaudeAcpAgent, spy: ReturnType<typeof vi.fn>) {
    const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
    const fromSpy = spy.mock.calls.flatMap((call: unknown[]) =>
      call
        .map((arg) => (arg as { env?: Record<string, string> } | undefined)?.env)
        .filter((env): env is Record<string, string> => !!env),
    );
    const fromSession = [session?.env, session?.accountEnv, session?.sdkOptions?.env].filter(
      (env): env is Record<string, string> => !!env,
    );
    return [...fromSpy, ...fromSession];
  }

  it("points the session at the selected account's configuration directory", async () => {
    const { agent, createSessionSpy } = createAgent();

    await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: ACCOUNT_CONFIG_ID,
      value: PERSONAL.name,
    });

    const envs = appliedEnvs(agent, createSessionSpy);
    expect(
      envs.some((env) => env.CLAUDE_CONFIG_DIR === PERSONAL.configDir),
      "the selected account's configuration directory must reach the session's env",
    ).toBe(true);
    // And never the account that was NOT selected.
    expect(envs.some((env) => env.CLAUDE_CONFIG_DIR === WORK.configDir)).toBe(false);

    const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
    const option = accountOption(session.configOptions);
    expect(option?.currentValue).toBe(PERSONAL.name);
  });

  it("requires no separate agent entry to switch account", async () => {
    const { agent, createSessionSpy } = createAgent();
    const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];

    await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: ACCOUNT_CONFIG_ID,
      value: PERSONAL.name,
    });

    // The switch is a session property: no agent was declared, added or
    // selected to carry it (D1/D9 — the whole feature fits in the adapter).
    expect(session.agents).toEqual([]);
    expect(session.currentAgent).toBe("default");
    expect(appliedEnvs(agent, createSessionSpy).length).toBeGreaterThan(0);
  });

  it("refuses an account that was not declared", async () => {
    const { agent } = createAgent();

    await expect(
      agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: ACCOUNT_CONFIG_ID,
        value: "undeclared",
      }),
    ).rejects.toThrow();
  });
});

describe("R6.4 — only the account in force, and no credential material on the wire", () => {
  /** Anything that looks like a credential, a token, or a path to a credential
   *  store. The selector transports display names; it opens no file. */
  const CREDENTIAL_SHAPED =
    /(sk-ant-|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|secret|password|cookie|credentials\.json|oauth)/i;

  it("carries no credential material and no filesystem path in the advertised option", () => {
    const option = accountOption(optionsFor([WORK, PERSONAL], WORK.name));
    expect(option).toBeDefined();

    const wire = JSON.stringify(option);
    expect(wire).not.toMatch(CREDENTIAL_SHAPED);
    // The configuration directory is where credentials live: it is the
    // adapter's business, never the client's.
    expect(wire).not.toContain(WORK.configDir);
    expect(wire).not.toContain(PERSONAL.configDir);
  });

  it("reports no usage for an account that is not in force", async () => {
    const notifications: Array<Record<string, any>> = [];
    const client = {
      sessionUpdate: async (n: Record<string, any>) => {
        notifications.push(n);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
    (agent as unknown as { createSession: unknown }).createSession = vi.fn(async () => ({
      sessionId: SESSION_ID,
      modes: MOCK_MODES,
      models: MOCK_MODELS,
      configOptions: [],
    }));
    (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID] = {
      query: makeMockQuery(),
      input: null,
      cancelled: false,
      cwd: "/test",
      permissionMode: "default",
      settingsManager: { getSettings: () => ({ accounts: [WORK, PERSONAL] }) },
      declaredAccounts: [WORK, PERSONAL],
      currentAccount: WORK.name,
      modes: structuredClone(MOCK_MODES),
      models: structuredClone(MOCK_MODELS),
      modelInfos: MODEL_INFOS,
      agents: [],
      currentAgent: "default",
      configOptions: optionsFor([WORK, PERSONAL], WORK.name),
      contextWindowSize: 200000,
      toolUseCache: {},
      emittedToolCalls: new Set(),
    };

    await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: ACCOUNT_CONFIG_ID,
      value: PERSONAL.name,
    });

    const metas = notifications
      .map((n) => JSON.stringify(n.update?._meta ?? n._meta ?? null))
      .filter((m) => m !== "null");
    for (const meta of metas) {
      expect(meta).not.toMatch(CREDENTIAL_SHAPED);
      expect(meta).not.toContain(WORK.configDir);
      expect(meta).not.toContain(PERSONAL.configDir);
    }

    // Quota belongs to the account in force. Nothing may report the other's.
    const quotaMentioningTheOtherAccount = notifications.filter((n) => {
      const wire = JSON.stringify(n);
      return /quota|rate_limit|utilization/i.test(wire) && wire.includes(WORK.name);
    });
    expect(quotaMentioningTheOtherAccount).toEqual([]);
  });
});
