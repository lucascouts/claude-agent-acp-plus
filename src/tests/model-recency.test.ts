import { describe, it, expect } from "vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { filterSupersededModels, modelGeneration } from "../model-recency.js";

// Rows mirror real supportedModels() output: alias rows carry `resolvedModel`,
// version-pinned rows put the wire id straight in `value`. The eleven-row shape
// below is the LIVE catalogue measured 2026-09-23 — the exact input this filter
// was written for.
const row = (value: string, displayName: string, resolvedModel?: string): ModelInfo =>
  ({
    value,
    displayName,
    description: "",
    ...(resolvedModel ? { resolvedModel } : {}),
  }) as ModelInfo;

const LIVE_CATALOGUE: ModelInfo[] = [
  row("default", "Default (recommended)", "claude-opus-5-5"),
  row("opus", "Opus 5.5", "claude-opus-5-5"),
  row("claude-fable-5-1", "Fable 5.1"),
  row("sonnet", "Sonnet 5", "claude-sonnet-5"),
  row("haiku", "Haiku 4.5", "claude-haiku-4-5-20251001"),
  row("claude-opus-5", "Opus 5"),
  row("claude-fable-5", "Fable 5"),
  row("claude-opus-4-8", "Opus 4.8"),
  row("claude-opus-4-7", "Opus 4.7"),
  row("claude-opus-4-6", "Opus 4.6"),
  row("claude-sonnet-4-6", "Sonnet 4.6"),
];

describe("model recency filter", () => {
  it("keeps exactly the newest row of each family on the live catalogue", () => {
    expect(filterSupersededModels(LIVE_CATALOGUE).map((m) => m.value)).toEqual([
      "default",
      "opus",
      "claude-fable-5-1",
      "sonnet",
      "haiku",
    ]);
  });

  it("preserves input order and object identity, never copies", () => {
    const kept = filterSupersededModels(LIVE_CATALOGUE);
    expect(kept[0]).toBe(LIVE_CATALOGUE[0]);
    expect(kept[2]).toBe(LIVE_CATALOGUE[2]);
  });

  it("ranks 5.5 above 5, and 5 above 4.8 — a bare major is not the newest", () => {
    // The trap: "claude-opus-5" and "claude-opus-5-5" share a major. Comparing
    // as strings or as a single number puts them in the wrong order.
    const kept = filterSupersededModels([
      row("claude-opus-5", "Opus 5"),
      row("claude-opus-5-5", "Opus 5.5"),
      row("claude-opus-4-8", "Opus 4.8"),
    ]);
    expect(kept.map((m) => m.value)).toEqual(["claude-opus-5-5"]);
  });

  it("does not let a dated snapshot outrank its own undated sibling", () => {
    // `claude-haiku-4-5-20251001` must parse as 4.5, not as 4.5.20251001, or the
    // alias row pointing at the bare id would be dropped as if it were older.
    expect(modelGeneration(row("x", "x", "claude-haiku-4-5-20251001"))?.version).toEqual([4, 5]);
    const kept = filterSupersededModels([
      row("haiku", "Haiku 4.5", "claude-haiku-4-5"),
      row("claude-haiku-4-5-20251001", "Haiku 4.5"),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("ignores the [1m] context hint, which names a lane and not a version", () => {
    const kept = filterSupersededModels([
      row("opus[1m]", "Opus (1M context)", "claude-opus-5-5[1m]"),
      row("claude-opus-4-8", "Opus 4.8"),
    ]);
    expect(kept.map((m) => m.value)).toEqual(["opus[1m]"]);
  });

  it("FAILS OPEN: an unparseable row is kept, never hidden", () => {
    // A third-party id, a renamed scheme, an alias with no resolvedModel. Showing
    // one row too many is recoverable; hiding a model the user has is not.
    const kept = filterSupersededModels([
      row("some-vendor/model-x", "Vendor X"),
      row("opus", "Opus"),
      row("claude-opus-5-5", "Opus 5.5"),
    ]);
    expect(kept.map((m) => m.value)).toEqual(["some-vendor/model-x", "opus", "claude-opus-5-5"]);
  });

  it("keeps every row of a family that ties for newest (alias plus its wire id)", () => {
    const kept = filterSupersededModels([
      row("opus", "Opus 5.5", "claude-opus-5-5"),
      row("claude-opus-5-5", "Opus 5.5"),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("is total on empty and single-row input", () => {
    expect(filterSupersededModels([])).toEqual([]);
    expect(filterSupersededModels([LIVE_CATALOGUE[0]])).toHaveLength(1);
  });

  it("never invents a row the input did not carry", () => {
    const values = new Set(LIVE_CATALOGUE.map((m) => m.value));
    for (const m of filterSupersededModels(LIVE_CATALOGUE)) expect(values.has(m.value)).toBe(true);
  });
});
