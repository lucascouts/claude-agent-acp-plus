import { describe, it, expect } from "vitest";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import {
  AccountUsageTracker,
  normalizeUtilization,
  toEpochSeconds,
  type AccountQuotaWindow,
} from "../account-usage.js";

/**
 * Story 002, sub-task 1.2 — the structured usage report mapped to quota windows.
 *
 * Contract (R1.3, R1.4, R1.5, R1.9, R1.10, R1.11): `windowsFrom` returns one
 * payload per window the report carries, in the `_meta["_claude/rateLimit"]`
 * wire shape patch `0011`'s `AccountUsage::ingest` reads — utilization already
 * on the 0..1 scale, the reset instant already in Unix seconds, and nothing at
 * all when plan rate limits do not apply.
 *
 * The 1%-versus-100% pair is the reason this file exists. `0011` normalises a
 * utilization defensively with `if v > 1.0 { v / 100.0 }`; the report's scale is
 * 0-100, so a window at 1% arrives as `1.0`, fails that test, and renders as a
 * FULL bar. The two must never reach the client as the same number (D2).
 */

type RateLimits = NonNullable<SDKControlGetUsageResponse["rate_limits"]>;

/** A structured report carrying only the parts this contract reads. */
function report(overrides: {
  rate_limits_available?: boolean;
  rate_limits?: RateLimits | null;
  subscription_type?: string | null;
}): SDKControlGetUsageResponse {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: overrides.subscription_type ?? null,
    rate_limits_available: overrides.rate_limits_available ?? true,
    rate_limits: overrides.rate_limits ?? null,
    behaviors: null,
  } as unknown as SDKControlGetUsageResponse;
}

/** The windows a fresh tracker (no measured status remembered) derives. */
function windowsOf(input: Parameters<typeof report>[0]): AccountQuotaWindow[] {
  return new AccountUsageTracker().windowsFrom(report(input));
}

function windowOfKind(windows: AccountQuotaWindow[], kind: string): AccountQuotaWindow {
  const found = windows.filter((window) => window.rateLimitType === kind);
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("utilization reaches the client on the 0..1 scale (R1.9)", () => {
  it("emits a window reported at 1% as 0.01, never as 1.0", () => {
    const windows = windowsOf({
      rate_limits: { five_hour: { utilization: 1, resets_at: null } },
    });

    const fiveHour = windowOfKind(windows, "five_hour");
    expect(fiveHour.utilization).toBe(0.01);
    expect(fiveHour.utilization).not.toBe(1.0);
  });

  it("emits a window reported at 100% as 1.0", () => {
    const windows = windowsOf({
      rate_limits: { five_hour: { utilization: 100, resets_at: null } },
    });

    expect(windowOfKind(windows, "five_hour").utilization).toBe(1.0);
  });

  it("keeps 1% and 100% apart — the two the client's own heuristic collapses", () => {
    // Hostile half: the defect is not "1% is wrong", it is "1% and 100% become
    // the same number". Asserting each alone would still pass an implementation
    // that emitted 1.0 for both.
    const atOnePercent = windowsOf({
      rate_limits: { five_hour: { utilization: 1, resets_at: null } },
    });
    const atFull = windowsOf({
      rate_limits: { five_hour: { utilization: 100, resets_at: null } },
    });

    expect(windowOfKind(atOnePercent, "five_hour").utilization).not.toBe(
      windowOfKind(atFull, "five_hour").utilization,
    );
  });

  it("emits a window whose utilization the report omits, without the field (R1.4)", () => {
    const fiveHour = windowOfKind(
      windowsOf({ rate_limits: { five_hour: { utilization: null, resets_at: null } } }),
      "five_hour",
    );

    // `0011` renders an absent utilization as an em dash; a zero would claim
    // the window is untouched rather than unmeasured.
    expect(fiveHour).not.toHaveProperty("utilization");
  });

  it("maps a 0-100 percentage to 0..1 and refuses a non-numeric one", () => {
    expect(normalizeUtilization(1)).toBe(0.01);
    expect(normalizeUtilization(100)).toBe(1);
    expect(normalizeUtilization(0)).toBe(0);
    expect(normalizeUtilization(null)).toBeUndefined();
    expect(normalizeUtilization(undefined)).toBeUndefined();
    expect(normalizeUtilization(Number.NaN)).toBeUndefined();
    expect(normalizeUtilization(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("the reset instant reaches the client as a number (R1.10)", () => {
  const ISO = "2026-09-03T12:00:00.750Z";
  const EPOCH_SECONDS = 1788436800;

  it("converts the report's ISO 8601 instant to Unix seconds", () => {
    const fiveHour = windowOfKind(
      windowsOf({ rate_limits: { five_hour: { utilization: 50, resets_at: ISO } } }),
      "five_hour",
    );

    // `0011` reads `resetsAt` with `as_i64()`: a string is dropped silently,
    // so the bar renders and the reset time never appears.
    expect(fiveHour.resetsAt).toBe(EPOCH_SECONDS);
  });

  it("omits the field when the instant will not parse, and still emits the window", () => {
    const windows = windowsOf({
      rate_limits: { five_hour: { utilization: 50, resets_at: "the third of never" } },
    });

    const fiveHour = windowOfKind(windows, "five_hour");
    expect(fiveHour).not.toHaveProperty("resetsAt");
    expect(fiveHour.utilization).toBe(0.5);
  });

  it("floors to whole seconds and refuses an unparseable instant", () => {
    expect(toEpochSeconds(ISO)).toBe(EPOCH_SECONDS);
    expect(toEpochSeconds("not a timestamp")).toBeUndefined();
    expect(toEpochSeconds("")).toBeUndefined();
    expect(toEpochSeconds(null)).toBeUndefined();
    expect(toEpochSeconds(undefined)).toBeUndefined();
  });
});

describe("every window the report carries is emitted (R1.3, R1.11)", () => {
  it("emits one payload per plan window, keyed by its own kind", () => {
    const windows = windowsOf({
      rate_limits: {
        five_hour: { utilization: 10, resets_at: null },
        seven_day: { utilization: 20, resets_at: null },
        seven_day_opus: { utilization: 30, resets_at: null },
        seven_day_sonnet: { utilization: 40, resets_at: null },
      },
    });

    expect(windows.map((window) => window.rateLimitType).sort()).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
    ]);
    expect(windowOfKind(windows, "seven_day").utilization).toBe(0.2);
  });

  it("emits a model-scoped window carrying its server-supplied display name", () => {
    const windows = windowsOf({
      rate_limits: {
        model_scoped: [{ display_name: "Fable", utilization: 25, resets_at: null }],
      },
    });

    const modelScoped = windowOfKind(windows, "model_scoped");
    expect(modelScoped.displayName).toBe("Fable");
    expect(modelScoped.utilization).toBe(0.25);
  });

  it("keeps two model-scoped windows distinguishable rather than collapsing them", () => {
    // Hostile half of R1.11: both entries carry the same `rateLimitType`, so the
    // only thing that tells them apart is the name and number they carry. An
    // implementation that emitted one entry, or two identical ones, satisfies
    // "a model_scoped window is emitted" and still loses a window.
    const windows = windowsOf({
      rate_limits: {
        model_scoped: [
          { display_name: "Fable", utilization: 25, resets_at: null },
          { display_name: "Ballad", utilization: 75, resets_at: null },
        ],
      },
    });

    const modelScoped = windows.filter((window) => window.rateLimitType === "model_scoped");
    expect(modelScoped).toHaveLength(2);
    expect(modelScoped.map((window) => window.displayName).sort()).toEqual(["Ballad", "Fable"]);
    expect(new Set(modelScoped.map((window) => window.utilization)).size).toBe(2);
  });
});

describe("no window is emitted where plan limits do not apply (R1.5)", () => {
  it("returns an empty list when the report declares limits unavailable", () => {
    // Hostile fixture: the flag is false while `rate_limits` still carries a
    // window. The flag governs, not the presence of data — a section of zeroes
    // would state the account is unused rather than unmeasured.
    expect(
      windowsOf({
        rate_limits_available: false,
        rate_limits: { five_hour: { utilization: 60, resets_at: null } },
      }),
    ).toEqual([]);
  });

  it("returns an empty list when the report carries no windows at all", () => {
    expect(windowsOf({ rate_limits: null })).toEqual([]);
    expect(windowsOf({ rate_limits: {} })).toEqual([]);
  });
});
