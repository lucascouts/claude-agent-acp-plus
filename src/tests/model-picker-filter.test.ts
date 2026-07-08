import { describe, it, expect } from "vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { applyAvailableModelsAllowlist, resolveModelPreference } from "../acp-agent.js";

/**
 * Contract fixed by story 006 (R4.2, R4.3): the deprecated-model filter is
 * applied at the picker's list-building sites — observable here through the
 * exported `applyAvailableModelsAllowlist` — while `resolveModelPreference`
 * keeps operating on the UNfiltered catalog, so a session whose persisted
 * preference is a deprecated model is still honored (visibility-only filter,
 * no forced migration).
 */

const CATALOG: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Use the default model",
  },
  {
    value: "opus",
    displayName: "Opus",
    description: "Opus 4.8 · Best for everyday, complex tasks",
  },
  {
    value: "claude-opus-3",
    displayName: "Claude Opus 3 (Deprecated)",
    description: "Legacy model",
  },
];

describe("applyAvailableModelsAllowlist deprecated-model filter (R4.2)", () => {
  it("hides a deprecated model even when the allowlist names it", () => {
    const result = applyAvailableModelsAllowlist(CATALOG, ["claude-opus-3"]);
    expect(result.find((m) => m.value === "claude-opus-3")).toBeUndefined();
  });

  it("keeps active allowlisted models visible (no over-filtering)", () => {
    const result = applyAvailableModelsAllowlist(CATALOG, ["opus"]);
    const entry = result.find((m) => m.value === "opus");
    expect(entry).toBeDefined();
    expect(entry?.displayName).toBe("Opus");
  });
});

describe("persisted-preference safety (R4.3)", () => {
  it("still resolves a persisted preference that points at a deprecated model", () => {
    // The filter affects picker visibility only: preference resolution runs
    // on the unfiltered catalog and must keep honoring the session's choice.
    expect(resolveModelPreference(CATALOG, "claude-opus-3")?.value).toBe("claude-opus-3");
  });
});
