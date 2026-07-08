import { describe, it, expect } from "vitest";
import {
  createFastModeConfigOption,
  resolveFastModeEnabled,
  FAST_MODE_CONFIG_ID,
  FAST_MODE_ON,
  FAST_MODE_OFF,
} from "../acp-agent.js";

/**
 * Contract fixed by story 006 (R2.1, R2.3): the Fast mode option is emitted as
 * an on/off select for every client — the boolean option SHAPE is removed
 * entirely (single-parameter factory, no `useBooleanOption`) — while boolean
 * VALUES remain accepted by the set-handler so clients that previously used
 * the boolean shape keep working without migrating persisted state.
 */

// Legacy-style caller: lets the suite prove that no argument combination can
// still produce the removed boolean shape, without pinning the old 2-arg
// signature at the type level.
const legacyCall = createFastModeConfigOption as unknown as (...args: unknown[]) => {
  type?: string;
  currentValue?: unknown;
};

describe("createFastModeConfigOption (select-only)", () => {
  it("declares exactly one parameter — the boolean-shape branch is gone (R2.1)", () => {
    expect(createFastModeConfigOption.length).toBe(1);
  });

  it("emits the on/off select for enabled=true", () => {
    expect(createFastModeConfigOption(true)).toMatchObject({
      id: FAST_MODE_CONFIG_ID,
      category: "model_config",
      type: "select",
      currentValue: FAST_MODE_ON,
      options: [
        { value: FAST_MODE_ON, name: "On" },
        { value: FAST_MODE_OFF, name: "Off" },
      ],
    });
  });

  it("emits the on/off select for enabled=false", () => {
    expect(createFastModeConfigOption(false)).toMatchObject({
      id: FAST_MODE_CONFIG_ID,
      type: "select",
      currentValue: FAST_MODE_OFF,
    });
  });

  it("never emits the boolean shape, even for a legacy boolean-capability call (R2.1)", () => {
    // Before this story, `createFastModeConfigOption(true, true)` produced
    // `{ type: "boolean", currentValue: true }`. That shape no longer exists.
    const option = legacyCall(true, true);
    expect(option.type).toBe("select");
    expect(option.currentValue).toBe(FAST_MODE_ON);
  });
});

describe("resolveFastModeEnabled (value compatibility preserved)", () => {
  const base = { sessionId: "s", configId: FAST_MODE_CONFIG_ID };

  it("still accepts native boolean values from boolean-era clients (R2.3)", () => {
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
