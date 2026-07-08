import { describe, it, expect, vi } from "vitest";
import type { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  buildConfigOptions,
  createFastModeConfigOption,
  fastModeStateEnabled,
  resolveFastModeEnabled,
  FAST_MODE_CONFIG_ID,
  FAST_MODE_ON,
  FAST_MODE_OFF,
  ClaudeAcpAgent,
  type AcpClient,
} from "../acp-agent.js";

const MODES = {
  currentModeId: "default",
  availableModes: [{ id: "default", name: "Default", description: "Standard behavior" }],
};

const MODELS = {
  currentModelId: "claude-opus-4-8",
  availableModels: [
    { modelId: "claude-opus-4-8", name: "Claude Opus", description: "Most capable" },
  ],
};

const MODEL_INFOS: ModelInfo[] = [
  { value: "claude-opus-4-8", displayName: "Claude Opus", description: "Most capable" },
];

describe("createFastModeConfigOption (select-only)", () => {
  // Boolean-shape assertions inverted to the on/off select: the boolean option
  // shape is gone for EVERY client (R2.1). `toEqual` keeps the exact-shape
  // strength the removed boolean-toggle test had.
  it("emits the exact on/off select for enabled=true", () => {
    expect(createFastModeConfigOption(true)).toEqual({
      id: FAST_MODE_CONFIG_ID,
      name: "Fast mode",
      description: expect.any(String),
      category: "model_config",
      type: "select",
      currentValue: FAST_MODE_ON,
      options: [
        { value: FAST_MODE_ON, name: "On" },
        { value: FAST_MODE_OFF, name: "Off" },
      ],
    });
  });

  it("emits the exact on/off select for enabled=false", () => {
    const option = createFastModeConfigOption(false);
    expect(option).toEqual({
      id: FAST_MODE_CONFIG_ID,
      name: "Fast mode",
      description: expect.any(String),
      category: "model_config",
      type: "select",
      currentValue: FAST_MODE_OFF,
      options: [
        { value: FAST_MODE_ON, name: "On" },
        { value: FAST_MODE_OFF, name: "Off" },
      ],
    });
    // Never the removed boolean shape.
    expect(option).not.toHaveProperty("currentValue", true);
    expect(option).not.toHaveProperty("type", "boolean");
  });
});

describe("resolveFastModeEnabled", () => {
  const base = { sessionId: "s", configId: FAST_MODE_CONFIG_ID };

  it("accepts native boolean values (boolean-era clients, R2.3)", () => {
    expect(resolveFastModeEnabled({ ...base, value: true })).toBe(true);
    expect(resolveFastModeEnabled({ ...base, value: false })).toBe(false);
  });

  it("accepts the on/off select values (R2.2)", () => {
    expect(resolveFastModeEnabled({ ...base, value: FAST_MODE_ON })).toBe(true);
    expect(resolveFastModeEnabled({ ...base, value: FAST_MODE_OFF })).toBe(false);
  });

  it("rejects any other value", () => {
    expect(() => resolveFastModeEnabled({ ...base, value: "maybe" })).toThrow(
      /Invalid value for config option fast/,
    );
  });
});

describe("fastModeStateEnabled", () => {
  it("treats cooldown as on (the user's intent persists through rate-limit cooldown)", () => {
    expect(fastModeStateEnabled("on")).toBe(true);
    expect(fastModeStateEnabled("cooldown")).toBe(true);
    expect(fastModeStateEnabled("off")).toBe(false);
  });
});

describe("buildConfigOptions Fast mode", () => {
  it("omits the Fast mode option when the model does not support it", () => {
    const options = buildConfigOptions(MODES, MODELS, MODEL_INFOS, undefined, [], "default", {
      supported: false,
      enabled: false,
    });
    expect(options.find((o) => o.id === FAST_MODE_CONFIG_ID)).toBeUndefined();
  });

  it("omits the Fast mode option when no fast mode state is provided", () => {
    const options = buildConfigOptions(MODES, MODELS, MODEL_INFOS, undefined, [], "default");
    expect(options.find((o) => o.id === FAST_MODE_CONFIG_ID)).toBeUndefined();
  });

  it("surfaces the on/off select when supported and enabled (R2.1)", () => {
    const options = buildConfigOptions(MODES, MODELS, MODEL_INFOS, undefined, [], "default", {
      supported: true,
      enabled: true,
    });
    expect(options).toContainEqual(createFastModeConfigOption(true));
  });

  it("surfaces the on/off select when supported and disabled (R2.1)", () => {
    const options = buildConfigOptions(MODES, MODELS, MODEL_INFOS, undefined, [], "default", {
      supported: true,
      enabled: false,
    });
    expect(options).toContainEqual(createFastModeConfigOption(false));
  });
});

describe("setSessionConfigOption Fast mode toggle", () => {
  const SESSION_ID = "fast-session";

  function setup() {
    const sessionUpdates: SessionNotification[] = [];
    const client = {
      sessionUpdate: async (n: SessionNotification) => {
        sessionUpdates.push(n);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;

    const agent = new ClaudeAcpAgent(client);
    // A boolean-era client (it advertised boolean config options): the option
    // is still emitted as a select (R2.1) and the boolean VALUES it sends on
    // set are still accepted (R2.3).
    (agent as unknown as { clientCapabilities: ClientCapabilities }).clientCapabilities = {
      session: { configOptions: { boolean: {} } },
    };

    const applyFlagSettings = vi.fn();
    (agent as unknown as { sessions: Record<string, unknown> }).sessions[SESSION_ID] = {
      query: { applyFlagSettings },
      fastModeEnabled: false,
      configOptions: [createFastModeConfigOption(false)],
    };

    return { agent, applyFlagSettings, sessionUpdates };
  }

  it("accepts boolean values on set and re-renders the select (R2.1, R2.3)", async () => {
    const { agent, applyFlagSettings } = setup();

    const onResponse = await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: FAST_MODE_CONFIG_ID,
      type: "boolean",
      value: true,
    });
    expect(applyFlagSettings).toHaveBeenCalledWith({ fastMode: true });
    expect(onResponse.configOptions).toContainEqual(createFastModeConfigOption(true));
    expect(
      (agent as unknown as { sessions: Record<string, { fastModeEnabled: boolean }> }).sessions[
        SESSION_ID
      ].fastModeEnabled,
    ).toBe(true);

    const offResponse = await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: FAST_MODE_CONFIG_ID,
      type: "boolean",
      value: false,
    });
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ fastMode: false });
    expect(offResponse.configOptions).toContainEqual(createFastModeConfigOption(false));
  });

  it("toggles Fast mode through the on/off select values (R2.2)", async () => {
    const { agent, applyFlagSettings } = setup();

    const response = await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: FAST_MODE_CONFIG_ID,
      value: FAST_MODE_ON,
    });
    expect(applyFlagSettings).toHaveBeenCalledWith({ fastMode: true });
    expect(response.configOptions).toContainEqual(createFastModeConfigOption(true));
  });

  it("does not change session state when the SDK rejects the flag", async () => {
    const { agent, applyFlagSettings } = setup();
    applyFlagSettings.mockRejectedValueOnce(new Error("nope"));

    await expect(
      agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: FAST_MODE_CONFIG_ID,
        type: "boolean",
        value: true,
      }),
    ).rejects.toThrow("nope");

    const session = (agent as unknown as { sessions: Record<string, { fastModeEnabled: boolean }> })
      .sessions[SESSION_ID];
    expect(session.fastModeEnabled).toBe(false);
  });
});

describe("syncFastModeState (SDK-driven state changes)", () => {
  const SESSION_ID = "fast-session";

  function setup(opts: { fastModeEnabled: boolean; withOption: boolean }) {
    const sessionUpdates: SessionNotification[] = [];
    const client = {
      sessionUpdate: async (n: SessionNotification) => {
        sessionUpdates.push(n);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;

    const agent = new ClaudeAcpAgent(client);
    (agent as unknown as { clientCapabilities: ClientCapabilities }).clientCapabilities = {
      session: { configOptions: { boolean: {} } },
    };

    const session = {
      query: {},
      fastModeEnabled: opts.fastModeEnabled,
      configOptions: opts.withOption ? [createFastModeConfigOption(opts.fastModeEnabled)] : [],
    };
    (agent as unknown as { sessions: Record<string, unknown> }).sessions[SESSION_ID] = session;

    const sync = (
      agent as unknown as {
        syncFastModeState: (
          sessionId: string,
          session: unknown,
          state: string | undefined,
        ) => Promise<void>;
      }
    ).syncFastModeState.bind(agent);

    return { sync, session, sessionUpdates };
  }

  it("emits a config_option_update (as a select) when the SDK reports a new state", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: false, withOption: true });

    await sync(SESSION_ID, session, "on");

    expect(session.fastModeEnabled).toBe(true);
    expect(session.configOptions).toContainEqual(createFastModeConfigOption(true));
    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0].update).toMatchObject({
      sessionUpdate: "config_option_update",
    });
    const updated = (
      sessionUpdates[0].update as { configOptions: ReturnType<typeof createFastModeConfigOption>[] }
    ).configOptions;
    expect(updated).toContainEqual(createFastModeConfigOption(true));
  });

  it("leaves the toggle on and quiet during a rate-limit cooldown", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: true, withOption: true });

    // cooldown is a transient suspension of an already-enabled fast mode.
    await sync(SESSION_ID, session, "cooldown");

    expect(session.fastModeEnabled).toBe(true);
    expect(sessionUpdates).toHaveLength(0);
  });

  it("never lets a stray cooldown spuriously enable a toggle the user has off", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: false, withOption: true });

    await sync(SESSION_ID, session, "cooldown");

    expect(session.fastModeEnabled).toBe(false);
    expect(sessionUpdates).toHaveLength(0);
  });

  it("clears the toggle when the SDK reports off", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: true, withOption: true });

    await sync(SESSION_ID, session, "off");

    expect(session.fastModeEnabled).toBe(false);
    expect(session.configOptions).toContainEqual(createFastModeConfigOption(false));
    expect(sessionUpdates).toHaveLength(1);
  });

  it("is a no-op when the reported state is undefined or unchanged", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: false, withOption: true });

    await sync(SESSION_ID, session, undefined);
    await sync(SESSION_ID, session, "off");

    expect(sessionUpdates).toHaveLength(0);
  });

  it("preserves the retained setting (no clobber) when the model has no Fast mode option", async () => {
    // Model without fast support: the SDK reports a capability-driven state, not
    // the user's intent. We must leave session.fastModeEnabled untouched so it's
    // correct when a supporting model is reselected — reconciling here was the
    // original intent-clobber bug.
    const enabledCase = setup({ fastModeEnabled: true, withOption: false });
    await enabledCase.sync(SESSION_ID, enabledCase.session, "off");
    expect(enabledCase.session.fastModeEnabled).toBe(true);
    expect(enabledCase.sessionUpdates).toHaveLength(0);

    const disabledCase = setup({ fastModeEnabled: false, withOption: false });
    await disabledCase.sync(SESSION_ID, disabledCase.session, "on");
    expect(disabledCase.session.fastModeEnabled).toBe(false);
    expect(disabledCase.sessionUpdates).toHaveLength(0);
  });
});
