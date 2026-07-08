import { describe, it, expect, vi } from "vitest";
import {
  THINKING_CONFIG_ID,
  THINKING_ON,
  THINKING_OFF,
  createThinkingConfigOption,
  resolveThinkingSelection,
  effectiveThinkingConfig,
} from "../thinking-option.js";

/**
 * Contract fixed by story 006 (R1.1, R1.4, R1.5, R1.6): the thinking-option
 * module exposes the "Thinking" select config-option factory, the value
 * resolver for `session/set_config_option`, and the precedence rule that
 * combines the session's thinking intent with the legacy `MAX_THINKING_TOKENS`
 * env resolution. These tests pin observable behavior only.
 */

/** Minimal Logger (acp-agent's Logger is `{ log, error }`). */
function mkLogger() {
  return { log: vi.fn(), error: vi.fn() };
}
type ThinkingLogger = Parameters<typeof effectiveThinkingConfig>[2];
const logger = () => mkLogger() as unknown as ThinkingLogger;

describe("thinking option constants", () => {
  it("pins the config id and select values", () => {
    expect(THINKING_CONFIG_ID).toBe("thinking");
    expect(THINKING_ON).toBe("on");
    expect(THINKING_OFF).toBe("off");
  });
});

describe("createThinkingConfigOption", () => {
  it("emits an on/off select in the Fast mode select style when enabled", () => {
    const option = createThinkingConfigOption(true);
    expect(option).toMatchObject({
      id: THINKING_CONFIG_ID,
      category: "model_config",
      type: "select",
      currentValue: THINKING_ON,
      options: [
        { value: THINKING_ON, name: "On" },
        { value: THINKING_OFF, name: "Off" },
      ],
    });
    expect(typeof option.name).toBe("string");
    expect(option.name.length).toBeGreaterThan(0);
    expect(typeof option.description).toBe("string");
  });

  it("reflects the disabled state in currentValue", () => {
    expect(createThinkingConfigOption(false)).toMatchObject({
      id: THINKING_CONFIG_ID,
      type: "select",
      currentValue: THINKING_OFF,
    });
  });
});

describe("resolveThinkingSelection", () => {
  it("maps the select values", () => {
    expect(resolveThinkingSelection(THINKING_ON)).toBe(true);
    expect(resolveThinkingSelection(THINKING_OFF)).toBe(false);
  });

  it("returns null for anything unrecognized (including booleans — the option was never boolean-shaped)", () => {
    expect(resolveThinkingSelection(true)).toBeNull();
    expect(resolveThinkingSelection(false)).toBeNull();
    expect(resolveThinkingSelection("maybe")).toBeNull();
    expect(resolveThinkingSelection(42)).toBeNull();
    expect(resolveThinkingSelection(undefined)).toBeNull();
    expect(resolveThinkingSelection(null)).toBeNull();
    expect(resolveThinkingSelection({})).toBeNull();
  });
});

describe("effectiveThinkingConfig precedence (intent × env)", () => {
  // ThinkingConfig union (sdk.d.ts 0.3.204): ThinkingAdaptive | ThinkingEnabled
  // | ThinkingDisabled; the disabled variant is exactly `{ type: "disabled" }`.

  it("intent=off disables thinking even when the env var is set (R1.5)", () => {
    expect(effectiveThinkingConfig(false, "12000", logger())).toEqual({ type: "disabled" });
    expect(effectiveThinkingConfig(false, undefined, logger())).toEqual({ type: "disabled" });
  });

  it("intent=on with the env var set uses the env resolution (R1.4)", () => {
    expect(effectiveThinkingConfig(true, "12000", logger())).toEqual({
      type: "enabled",
      budgetTokens: 12000,
    });
  });

  it("intent=on without the env var yields an SDK enabled (non-disabled) config (R1.4)", () => {
    const config = effectiveThinkingConfig(true, undefined, logger());
    // Behavior-level: the union allows `enabled` or `adaptive` as the SDK
    // enabled default; the only forbidden outcomes are `disabled` and unset.
    expect(config).toBeDefined();
    expect(config?.type).not.toBe("disabled");
  });

  it("intent untouched preserves today's env-driven behavior exactly (R1.6)", () => {
    expect(effectiveThinkingConfig(undefined, undefined, logger())).toBeUndefined();
    expect(effectiveThinkingConfig(undefined, "12000", logger())).toEqual({
      type: "enabled",
      budgetTokens: 12000,
    });
    expect(effectiveThinkingConfig(undefined, "0", logger())).toEqual({ type: "disabled" });
  });

  it("intent untouched ignores a non-numeric env value with a logged error (R1.6)", () => {
    const log = mkLogger();
    expect(
      effectiveThinkingConfig(undefined, "lots", log as unknown as ThinkingLogger),
    ).toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});
