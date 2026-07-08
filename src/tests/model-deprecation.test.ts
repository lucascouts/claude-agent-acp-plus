import { describe, it, expect } from "vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { isDeprecatedModel, filterDeprecatedModels } from "../model-deprecation.js";

/**
 * Contract fixed by story 006 (R4.1): the deprecation heuristic is a single
 * exported function matching /deprecated|legacy/ case-insensitively over
 * `displayName` and `description` ONLY (the SDK exposes no deprecation flag
 * as of 0.3.204), plus a list filter built on it.
 */

// Row shapes mirror real supportedModels() output (see model-resolution.test.ts).
const ACTIVE_MODELS: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-4-8[1m]",
    displayName: "Default (recommended)",
    description: "Use the default model (currently Opus 4.8 (1M context))",
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-4-8[1m]",
    displayName: "Opus",
    description: "Opus 4.8 with 1M context · Best for everyday, complex tasks",
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

const DEPRECATED_BY_NAME: ModelInfo = {
  value: "claude-opus-3",
  displayName: "Claude Opus 3 (Deprecated)",
  description: "Older generation",
};

const DEPRECATED_BY_DESCRIPTION: ModelInfo = {
  value: "claude-instant",
  displayName: "Claude Instant",
  description: "Legacy model, retired soon",
};

describe("isDeprecatedModel", () => {
  it("flags 'deprecated' in the displayName", () => {
    expect(isDeprecatedModel(DEPRECATED_BY_NAME)).toBe(true);
  });

  it("flags 'legacy' in the description", () => {
    expect(isDeprecatedModel(DEPRECATED_BY_DESCRIPTION)).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(
      isDeprecatedModel({ value: "m1", displayName: "Old Model", description: "DEPRECATED" }),
    ).toBe(true);
    expect(isDeprecatedModel({ value: "m2", displayName: "Legacy Sonnet", description: "" })).toBe(
      true,
    );
  });

  it("looks at displayName and description only — never the value", () => {
    expect(
      isDeprecatedModel({
        value: "claude-deprecated-x",
        displayName: "Claude X",
        description: "Great model",
      }),
    ).toBe(false);
  });

  it("keeps every active catalog row (false-positive guard, unit level)", () => {
    for (const model of ACTIVE_MODELS) {
      expect(isDeprecatedModel(model), `flagged active model ${model.value}`).toBe(false);
    }
  });
});

describe("filterDeprecatedModels", () => {
  it("removes deprecated rows and preserves active rows in order", () => {
    const mixed = [
      ACTIVE_MODELS[0],
      DEPRECATED_BY_NAME,
      ACTIVE_MODELS[2],
      DEPRECATED_BY_DESCRIPTION,
      ACTIVE_MODELS[3],
    ];
    expect(filterDeprecatedModels(mixed)).toEqual([
      ACTIVE_MODELS[0],
      ACTIVE_MODELS[2],
      ACTIVE_MODELS[3],
    ]);
  });

  it("is the identity on an all-active catalog", () => {
    expect(filterDeprecatedModels(ACTIVE_MODELS)).toEqual(ACTIVE_MODELS);
  });

  it("handles an empty catalog", () => {
    expect(filterDeprecatedModels([])).toEqual([]);
  });
});
