import { describe, it, expect } from "vitest";
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  AccountUsageTracker,
  normalizeUtilization,
  type AccountQuotaWindow,
} from "../account-usage.js";

/**
 * Story 002 — the two defects the CROSS-LANGUAGE BOUNDARY REVIEW of 2026-09-03
 * found in `account-usage.ts`, where this TypeScript adapter meets the Rust
 * panel (`0011-account-usage-panel.patch`, `AccountUsage::ingest`).
 *
 * Neither is a style point: each puts a wrong thing on a user's screen, and
 * neither is visible from one side of the boundary alone — which is why this
 * file asserts on the COMPOSED outcome wherever it can, not just on what this
 * module returns.
 *
 * **B2 — a window past 100% rendered as a 1% bar.** The two normalisations
 * compose. `0011` normalises defensively with `if v > 1.0 { v / 100.0 }`, so a
 * report of 137% divided once here becomes `1.37`, passes that test, is divided
 * a SECOND time and lands on `0.0137`. Discontinuous at 100 — `100` filled the
 * bar and `100.000001` emptied it — and self-contradictory, because
 * `deriveStatus` read the pre-clamp `1.37` as `allowed_warning` and coloured the
 * row as a warning next to a label reading "1%". Clamping here closes it: nothing
 * emitted can exceed 1.0, so the client's heuristic can never fire.
 *
 * **B1 — every window we emitted cleared the account-wide flags.** `ingest`
 * reads `errorCode` and `isUsingOverage`/`overageInUse` BEFORE its
 * `rateLimitType` guard, and treats absent as FALSE rather than as unknown. Our
 * payloads carried neither, and we send up to eight per turn, so the "usage
 * credits required" warning lit on a live event and went out at the end of the
 * very next turn — at exactly the moment it existed for.
 */

const FIVE_HOUR_ISO = "2026-09-03T12:00:00.000Z";
const FIVE_HOUR_EPOCH = 1788436800;

type RateLimits = NonNullable<SDKControlGetUsageResponse["rate_limits"]>;

function report(rate_limits: RateLimits): SDKControlGetUsageResponse {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits,
    behaviors: null,
  } as unknown as SDKControlGetUsageResponse;
}

/** How many payloads {@link everyWindow} produces: 5 plan + 2 model-scoped + 1 overage. */
const EVERY_WINDOW_COUNT = 8;

/**
 * One of every window kind this module emits: five plan windows, two
 * model-scoped buckets and an enabled overage. EIGHT payloads for one report —
 * the fan-out that turns "one payload forgot a flag" into "the flag is cleared",
 * since `ingest` reads the flags off whichever payload it is handed.
 */
function everyWindow(): RateLimits {
  return {
    five_hour: { utilization: 10, resets_at: FIVE_HOUR_ISO },
    seven_day: { utilization: 20, resets_at: null },
    seven_day_oauth_apps: { utilization: 30, resets_at: null },
    seven_day_opus: { utilization: 40, resets_at: null },
    seven_day_sonnet: { utilization: 50, resets_at: null },
    model_scoped: [
      { display_name: "Fable", utilization: 60, resets_at: null },
      { display_name: "Ballad", utilization: 70, resets_at: null },
    ],
    extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 25, utilization: 25 },
  };
}

/** A live `rate_limit_event` payload, five-hour and unremarkable unless overridden. */
function liveEvent(overrides: Partial<SDKRateLimitInfo> = {}): SDKRateLimitInfo {
  return {
    status: "allowed",
    rateLimitType: "five_hour",
    resetsAt: FIVE_HOUR_EPOCH,
    ...overrides,
  } as SDKRateLimitInfo;
}

/** The windows a fresh tracker — no live event seen — derives from one report. */
function windowsOf(rate_limits: RateLimits): AccountQuotaWindow[] {
  return new AccountUsageTracker().windowsFrom(report(rate_limits));
}

function windowOfKind(windows: AccountQuotaWindow[], kind: string): AccountQuotaWindow {
  const found = windows.filter((window) => window.rateLimitType === kind);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/**
 * One wire key across every window of a full report, with the window count
 * asserted in the same breath — an "every window carries it" that ran over an
 * empty list would otherwise be vacuously true.
 *
 * A key this module OMITS reads as `undefined` here, which is what `ingest` makes
 * of it too; the tests that pin omission still assert absence itself, because
 * "omitted" and "present and undefined" are different payloads on the wire.
 */
function everyWindowsValueOf<Key extends keyof AccountQuotaWindow>(
  windows: AccountQuotaWindow[],
  key: Key,
): AccountQuotaWindow[Key][] {
  expect(windows).toHaveLength(EVERY_WINDOW_COUNT);
  return windows.map((window) => window[key]);
}

/** The same value, once per window a full report emits. */
function onEveryWindow<Value>(value: Value): Value[] {
  return new Array<Value>(EVERY_WINDOW_COUNT).fill(value);
}

/**
 * `0011`'s OWN normalisation, transcribed from the patch (line 236):
 *
 * ```rust
 * .map(|v| (if v > 1.0 { v / 100.0 } else { v }).clamp(0.0, 1.0) as f32)
 * ```
 *
 * This is what makes the assertions below composed rather than local: the bar a
 * user sees is this function applied to what we emit, and B2 lives in the pair,
 * not in either half.
 */
function barValue(utilization: number | undefined): number | undefined {
  if (utilization === undefined) {
    return undefined;
  }
  const normalised = utilization > 1 ? utilization / 100 : utilization;
  return Math.min(Math.max(normalised, 0), 1);
}

/** What one five-hour window reported at `percentage` reaches the wire with. */
function utilizationOf(percentage: number): number {
  const window = windowOfKind(
    windowsOf({ five_hour: { utilization: percentage, resets_at: null } }),
    "five_hour",
  );
  // Hostile against the empty implementation: an adapter that emitted nothing,
  // or emitted the window without the field, must fail here rather than sail
  // through every comparison below on a pair of undefineds.
  expect(window).toHaveProperty("utilization");
  expect(typeof window.utilization).toBe("number");
  return window.utilization as number;
}

/** The bar `0011` draws for a window this report states at `percentage`. */
function barFor(percentage: number): number {
  return barValue(utilizationOf(percentage)) as number;
}

describe("B2 — a saturated window fills its bar instead of emptying it", () => {
  it("emits 137% as 1, and the client draws it full rather than at 1%", () => {
    expect(utilizationOf(137)).toBe(1);

    // The composed outcome, which is the whole point: unclamped, `1.37` survives
    // the client's `> 1.0` test, is divided a second time, and 137% of a quota
    // renders as a 1% bar.
    expect(barFor(137)).toBe(1);
    expect(barFor(137)).not.toBe(0.0137);
  });

  it("closes the discontinuity at 100, where a hair over used to empty the bar", () => {
    expect(utilizationOf(100)).toBe(1);
    expect(utilizationOf(100.000001)).toBe(1);

    // `100` filled the bar and `100.000001` emptied it — the same window, one
    // microscopic step apart, on opposite ends of the panel.
    expect(barFor(100)).toBe(barFor(100.000001));
    expect(barFor(100.000001)).toBe(1);
  });

  it("clamps a negative percentage to an empty bar, never below one", () => {
    expect(normalizeUtilization(-5)).toBe(0);
    expect(normalizeUtilization(-0.0001)).toBe(0);
    // `toBe` compares with `Object.is`, so this also pins the SIGN: `-0`
    // round-trips through `as f32` in Rust and is not what an empty bar is.
    expect(utilizationOf(-5)).toBe(0);
    expect(barFor(-5)).toBe(0);
  });

  it("keeps 1% and 137% apart on the wire AND on the bar", () => {
    // The assertion that pins the whole defect. Each value asserted alone still
    // passes against the broken implementation — it emitted 0.01 for the first
    // and 0.0137 for the second, both "small" — and a user could not tell a
    // barely-touched window from an exhausted one.
    expect(barFor(1)).not.toBe(barFor(137));
    expect(barFor(137)).toBeGreaterThan(barFor(1));
    expect(barFor(1)).toBeCloseTo(0.01, 10);
    expect(barFor(137)).toBe(1);
  });

  it("never draws a smaller bar for a larger report", () => {
    // Monotonicity is the general form of both halves above: the broken
    // composition climbs to 1.0 at 100 and falls off a cliff to 0.01 one step
    // later, so it fails here without needing to name 137 at all.
    const percentages = [0, 1, 25, 50, 80, 99.9, 100, 100.000001, 137, 1000];
    const bars = percentages.map((percentage) => barFor(percentage));

    for (let index = 1; index < bars.length; index += 1) {
      expect(bars[index]!).toBeGreaterThanOrEqual(bars[index - 1]!);
    }
    expect(bars[0]).toBe(0);
    expect(bars.at(-1)).toBe(1);
  });

  it("does not contradict itself: the saturated row is full AND warning-coloured", () => {
    const window = windowOfKind(
      windowsOf({ five_hour: { utilization: 137, resets_at: FIVE_HOUR_ISO } }),
      "five_hour",
    );

    // `deriveStatus` now reads the clamped value, so the colour and the number
    // agree. Before, the row said "warning" while the label said "1%".
    expect(window.status).toBe("allowed_warning");
    expect(window.utilization).toBe(1);
  });
});

describe("B1 — the account-wide flags survive the windows we emit", () => {
  it("emits neither flag before any live event has measured one", () => {
    const windows = new AccountUsageTracker().windowsFrom(report(everyWindow()));

    // Hostile against a no-op: an absence only means something if the windows
    // are there to be missing it. Omitting both leaves `ingest` defaulting to
    // false, which is the behaviour that predates this transport.
    expect(windows).toHaveLength(EVERY_WINDOW_COUNT);
    for (const window of windows) {
      expect(window).not.toHaveProperty("errorCode");
      expect(window).not.toHaveProperty("isUsingOverage");
    }
  });

  it("re-asserts credits_required on EVERY window of the next report", () => {
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(liveEvent({ errorCode: "credits_required" }));

    const windows = tracker.windowsFrom(report(everyWindow()));

    // Every window, not the first: `ingest` reads the flag off whichever payload
    // it is handed, so one window omitting it puts the warning back out.
    expect(everyWindowsValueOf(windows, "errorCode")).toEqual(onEveryWindow("credits_required"));
  });

  it("keeps asserting it turn after turn, because only a live event may clear it", () => {
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(liveEvent({ errorCode: "credits_required" }));

    tracker.windowsFrom(report(everyWindow()));
    const nextTurn = tracker.windowsFrom(report(everyWindow()));

    // The defect in one line: the warning lit on a live event and went out at
    // the end of the very next turn.
    expect(everyWindowsValueOf(nextTurn, "errorCode")).toEqual(onEveryWindow("credits_required"));
  });

  it("stops asserting it once a later live event carries no errorCode", () => {
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(liveEvent({ errorCode: "credits_required" }));
    tracker.windowsFrom(report(everyWindow()));

    // A live event is the one thing that clears the flags: this one says nothing
    // about credits, exactly as it would have cleared `ingest`'s own copy.
    tracker.recordMeasured(liveEvent());
    const windows = tracker.windowsFrom(report(everyWindow()));

    expect(windows).toHaveLength(EVERY_WINDOW_COUNT);
    for (const window of windows) {
      expect(window).not.toHaveProperty("errorCode");
    }
  });

  it("rides every window with isUsingOverage once an event has measured it", () => {
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(liveEvent({ isUsingOverage: true }));

    const windows = tracker.windowsFrom(report(everyWindow()));

    expect(everyWindowsValueOf(windows, "isUsingOverage")).toEqual(onEveryWindow(true));
  });

  it("honours overageInUse, the alternative spelling the client also reads", () => {
    // The SDK declares `isUsingOverage` and `overageInUse` as two separate
    // optional fields, and `ingest` falls back from the first to the second. An
    // event using only the second measures the same state, and is re-emitted
    // under the spelling the client reads first.
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(liveEvent({ isUsingOverage: undefined, overageInUse: true }));

    const windows = tracker.windowsFrom(report(everyWindow()));

    expect(everyWindowsValueOf(windows, "isUsingOverage")).toEqual(onEveryWindow(true));
  });

  it("prefers isUsingOverage over overageInUse when an event carries both", () => {
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(liveEvent({ isUsingOverage: false, overageInUse: true }));

    // `ingest` reads `isUsingOverage` first and never looks at the other, so
    // reading them in any other order would put us out of step with the panel.
    const windows = tracker.windowsFrom(report(everyWindow()));

    expect(everyWindowsValueOf(windows, "isUsingOverage")).toEqual(onEveryWindow(false));
  });

  it("stops asserting overage once a later live event measures none", () => {
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(liveEvent({ isUsingOverage: true }));
    tracker.windowsFrom(report(everyWindow()));

    tracker.recordMeasured(liveEvent());
    const windows = tracker.windowsFrom(report(everyWindow()));

    expect(windows).toHaveLength(EVERY_WINDOW_COUNT);
    for (const window of windows) {
      expect(window).not.toHaveProperty("isUsingOverage");
    }
  });

  it("tells a measured false apart from a state nobody measured", () => {
    // Both leave `ingest` with `false`, and they are still different claims: one
    // was reported, the other never asked about. Emitting the measured one keeps
    // this module's output a record of what the account said.
    const measuredFalse = new AccountUsageTracker();
    measuredFalse.recordMeasured(liveEvent({ isUsingOverage: false }));

    const measured = windowOfKind(measuredFalse.windowsFrom(report(everyWindow())), "five_hour");
    const never = windowOfKind(
      new AccountUsageTracker().windowsFrom(report(everyWindow())),
      "five_hour",
    );

    expect(measured).toHaveProperty("isUsingOverage", false);
    expect(never).not.toHaveProperty("isUsingOverage");
  });

  it("registers the flags from a live event that names no window at all", () => {
    // The flags are read BEFORE the `rateLimitType` guard, mirroring `ingest`.
    // An event that only announces "credits required" carries no window to
    // attach a status to, and it is precisely the event that must not be dropped.
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(
      liveEvent({ rateLimitType: undefined, resetsAt: undefined, errorCode: "credits_required" }),
    );

    const windows = tracker.windowsFrom(report(everyWindow()));

    expect(everyWindowsValueOf(windows, "errorCode")).toEqual(onEveryWindow("credits_required"));
  });

  it("does not let a flags-only event disturb the measured-status memory", () => {
    // The guard still guards: reading the flags earlier must not also let a
    // window-less event overwrite the `rejected` measured for the five-hour
    // window, which is the one status the report can never derive.
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(liveEvent({ status: "rejected" }));
    tracker.recordMeasured(
      liveEvent({ rateLimitType: undefined, resetsAt: undefined, errorCode: "credits_required" }),
    );

    const fiveHour = windowOfKind(tracker.windowsFrom(report(everyWindow())), "five_hour");

    expect(fiveHour.status).toBe("rejected");
    expect(fiveHour.errorCode).toBe("credits_required");
  });

  it("carries no flag where the report itself carries no window", () => {
    // Nothing is emitted when plan limits do not apply, so nothing re-asserts
    // and nothing clears — the flags ride windows, they do not create them.
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(liveEvent({ errorCode: "credits_required", isUsingOverage: true }));

    expect(tracker.windowsFrom(report({}))).toEqual([]);
  });
});
