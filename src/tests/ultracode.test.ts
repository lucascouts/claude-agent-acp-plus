/**
 * Ultracode entry of the Effort picker.
 *
 * The assertions that matter are the two the compound can get wrong silently:
 * the CLEAR on every non-Ultracode selection (an `undefined` there leaves
 * workflow orchestration running under a lowered effort — a state no picker
 * entry names), and the refusal to INFER Ultracode from `xhigh` alone.
 */

import { describe, expect, it } from "vitest";
import {
  effortOptionValue,
  isUltracodeAvailable,
  isUltracodeValue,
  ULTRACODE_EFFORT_LEVEL,
  ULTRACODE_OPTION_VALUE,
  ultracodeFlagSettings,
} from "../ultracode.js";
import { buildConfigOptions } from "../acp-agent.js";
import { EFFORT_CONFIG_ID } from "../session-config-ids.js";
import type { EffortLevel, ModelInfo } from "@anthropic-ai/claude-agent-sdk";

const MODES = {
  currentModeId: "default",
  availableModes: [{ id: "default", name: "Default", description: "Standard behavior" }],
};

const MODELS = {
  currentModelId: "m1",
  availableModels: [{ modelId: "m1", name: "M1", description: "A model" }],
};

const modelInfo = (levels: EffortLevel[]): ModelInfo[] => [
  {
    value: "m1",
    displayName: "M1",
    description: "A model",
    supportsEffort: levels.length > 0,
    supportedEffortLevels: levels,
  },
];

/** The effort option, narrowed to the select it always is — `SessionConfigOption`
 *  is a union and only the select arm carries `options`. */
function effortOf(...args: Parameters<typeof buildConfigOptions>) {
  const option = buildConfigOptions(...args).find((o) => o.id === EFFORT_CONFIG_ID);
  if (!option || option.type !== "select") return undefined;
  return option;
}

/** The effort option's values, in order. The SDK's select type allows GROUPS as
 *  well as options; the effort picker never emits one, and asserting that here
 *  keeps a future grouping change from failing as a type error in every case. */
function valuesOf(option: ReturnType<typeof effortOf>): string[] {
  return (option?.options ?? []).map((o) => {
    if (!("value" in o)) throw new Error("the effort picker must not emit option groups");
    return o.value;
  });
}

describe("ultracode: availability", () => {
  it("needs xhigh on the model — it is the level Ultracode stands for", () => {
    expect(isUltracodeAvailable(["low", "medium", "high"], {})).toBe(false);
    expect(isUltracodeAvailable(["low", "high", "xhigh"], {})).toBe(true);
  });

  it("is withheld when workflows are disabled, because that is the other half", () => {
    expect(isUltracodeAvailable(["xhigh"], { disableWorkflows: true })).toBe(false);
    expect(isUltracodeAvailable(["xhigh"], { disableWorkflows: false })).toBe(true);
  });

  it("treats an ABSENT disableWorkflows as not-disabled, never as unknown", () => {
    // The reference client compares `=== !0`, so anything that is not literally
    // true opens the gate. A guard that closed on `undefined` would hide the
    // entry from every session whose settings simply do not mention workflows,
    // which is most of them.
    expect(isUltracodeAvailable(["xhigh"], undefined)).toBe(true);
    expect(isUltracodeAvailable(["xhigh"], {})).toBe(true);
  });
});

describe("ultracode: the flag payload", () => {
  it("sends BOTH keys when selected, at the level it stands for", () => {
    expect(ultracodeFlagSettings(ULTRACODE_OPTION_VALUE)).toEqual({
      effortLevel: ULTRACODE_EFFORT_LEVEL,
      ultracode: true,
    });
  });

  it("CLEARS the flag with an explicit null on every other selection", () => {
    // The hostile case: `undefined` is dropped by JSON transport and the SDK
    // shallow-merges, so an omitted key leaves Ultracode ON under a lowered
    // effort. Asserting the key is PRESENT and null, not merely falsy.
    for (const v of ["low", "high", "xhigh", "max", "default", undefined]) {
      const payload = ultracodeFlagSettings(v);
      expect(Object.keys(payload)).toContain("ultracode");
      expect(payload.ultracode).toBeNull();
    }
  });

  it("maps the default sentinel and an absent option onto a cleared level", () => {
    expect(ultracodeFlagSettings("default").effortLevel).toBeNull();
    expect(ultracodeFlagSettings(undefined).effortLevel).toBeNull();
    expect(ultracodeFlagSettings("high").effortLevel).toBe("high");
  });

  it("keeps xhigh distinguishable from Ultracode on the wire", () => {
    expect(ultracodeFlagSettings("xhigh")).toEqual({ effortLevel: "xhigh", ultracode: null });
    expect(isUltracodeValue("xhigh")).toBe(false);
    expect(isUltracodeValue(ULTRACODE_OPTION_VALUE)).toBe(true);
  });
});

describe("ultracode: the displayed value", () => {
  it("does NOT infer Ultracode from an xhigh level", () => {
    expect(effortOptionValue("xhigh", { available: true, enabled: false })).toBe("xhigh");
  });

  it("shows the flag over the level when it is on and available", () => {
    expect(effortOptionValue("xhigh", { available: true, enabled: true })).toBe(
      ULTRACODE_OPTION_VALUE,
    );
  });

  it("falls back to the level when the entry is not rendered", () => {
    // A model without xhigh drops the entry; a session still carrying the
    // intent must not display a value the picker has no row for.
    expect(effortOptionValue("high", { available: false, enabled: true })).toBe("high");
  });
});

describe("ultracode: the picker", () => {
  it("appends the entry after the last level, and only with xhigh", () => {
    const opt = effortOf(MODES, MODELS, modelInfo(["low", "high", "xhigh"]));
    expect(valuesOf(opt)).toEqual(["default", "low", "high", "xhigh", ULTRACODE_OPTION_VALUE]);

    const without = effortOf(MODES, MODELS, modelInfo(["low", "high"]));
    expect(valuesOf(without)).toEqual(["default", "low", "high"]);
  });

  it("omits the entry when workflows are disabled", () => {
    const opt = effortOf(
      MODES,
      MODELS,
      modelInfo(["xhigh"]),
      undefined,
      [],
      "default",
      undefined,
      undefined,
      undefined,
      { disableWorkflows: true },
    );
    expect(valuesOf(opt)).toEqual(["default", "xhigh"]);
  });

  it("selects the entry when the session carries the intent", () => {
    const opt = effortOf(
      MODES,
      MODELS,
      modelInfo(["xhigh"]),
      "xhigh",
      [],
      "default",
      undefined,
      undefined,
      {
        available: true,
        enabled: true,
      },
    );
    expect(opt?.currentValue).toBe(ULTRACODE_OPTION_VALUE);
  });

  it("falls back to Default when the intent survives a model that lost xhigh", () => {
    // The regression this exists for: `validEffort` must reject a value the
    // option list does not carry, or the client renders a selection with no row.
    const opt = effortOf(
      MODES,
      MODELS,
      modelInfo(["low", "high"]),
      "xhigh",
      [],
      "default",
      undefined,
      undefined,
      {
        available: false,
        enabled: true,
      },
    );
    expect(opt?.currentValue).toBe("default");
    expect(valuesOf(opt)).not.toContain(ULTRACODE_OPTION_VALUE);
  });
});
