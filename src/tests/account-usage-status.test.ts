import { describe, it, expect } from "vitest";
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  AccountUsageTracker,
  deriveStatus,
  WARNING_THRESHOLD,
  type AccountQuotaWindow,
} from "../account-usage.js";

/**
 * Story 002, sub-task 1.3 — the status every emitted window carries.
 *
 * Contract (R1.6, R1.6.1): the structured report carries no status and `0011`
 * needs one to place a bar, so the adapter derives it from utilization —
 * `allowed` below the warning threshold, `allowed_warning` at or above it, and
 * NEVER `rejected`, which the adapter cannot know. A status MEASURED by a live
 * `rate_limit_event` outranks a derived one for the life of that window
 * INSTANCE, identified by its reset instant, and is dropped once that instant
 * advances — otherwise a refilled window still reads blocked.
 *
 * `0011`'s `most_constrained` ranks by status BEFORE utilization, which is why a
 * wrong status is worse than a wrong number.
 */

const FIVE_HOUR_ISO = "2026-09-03T12:00:00.000Z";
const FIVE_HOUR_EPOCH = 1788436800;
const NEXT_WINDOW_ISO = "2026-09-03T17:00:00.000Z";
const NEXT_WINDOW_EPOCH = 1788454800;

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

/** A five-hour window a quarter used — well below the warning threshold, so its
 *  derived status is `allowed` and any other status can only come from memory. */
function quietFiveHour(resets_at: string | null = FIVE_HOUR_ISO): RateLimits {
  return { five_hour: { utilization: 25, resets_at } };
}

function measured(overrides: Partial<SDKRateLimitInfo> = {}): SDKRateLimitInfo {
  return {
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAt: FIVE_HOUR_EPOCH,
    ...overrides,
  } as SDKRateLimitInfo;
}

function windowOfKind(windows: AccountQuotaWindow[], kind: string): AccountQuotaWindow {
  const found = windows.filter((window) => window.rateLimitType === kind);
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("a status is derived, and never invented as rejected (R1.6)", () => {
  it("derives allowed below the warning threshold", () => {
    expect(deriveStatus(0)).toBe("allowed");
    expect(deriveStatus(WARNING_THRESHOLD - 0.01)).toBe("allowed");
  });

  it("derives allowed_warning at and above the warning threshold", () => {
    expect(deriveStatus(WARNING_THRESHOLD)).toBe("allowed_warning");
    expect(deriveStatus(1)).toBe("allowed_warning");
  });

  it("never derives rejected, from any input at all", () => {
    // `rejected` means a request was refused. Nothing in a utilization report
    // says that, so no input may produce it: emitting it would be a claim, not
    // a derivation, and it outranks every other status in `most_constrained`.
    const inputs = [undefined, 0, 0.01, 0.5, WARNING_THRESHOLD, 0.99, 1, 1.5, 100];

    for (const input of inputs) {
      const derived = deriveStatus(input);
      expect(derived).not.toBe("rejected");
      expect(["allowed", "allowed_warning"]).toContain(derived);
    }
  });

  it("gives every emitted window a status, since `ingest` places no bar without one", () => {
    const windows = new AccountUsageTracker().windowsFrom(
      report({
        five_hour: { utilization: 25, resets_at: FIVE_HOUR_ISO },
        seven_day: { utilization: 95, resets_at: null },
      }),
    );

    expect(windowOfKind(windows, "five_hour").status).toBe("allowed");
    expect(windowOfKind(windows, "seven_day").status).toBe("allowed_warning");
  });
});

describe("a measured status outranks a derived one for its instance (R1.6)", () => {
  it("re-asserts a measured rejected on the next derived emission for the same instant", () => {
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(measured());

    const window = windowOfKind(tracker.windowsFrom(report(quietFiveHour())), "five_hour");

    // Same window instance: the report's own numbers would derive `allowed`,
    // which is LESS constrained than what was measured.
    expect(window.status).toBe("rejected");
    expect(window.utilization).toBe(0.25);
  });

  it("keeps the more constrained status when the derived one is the stricter of the pair", () => {
    // The converse half. R1.6 forbids reporting less constrained than measured;
    // it does not license SOFTENING a window that has since crossed the warning
    // threshold back down to the `allowed` that was measured earlier.
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(measured({ status: "allowed" }));

    const window = windowOfKind(
      tracker.windowsFrom(report({ five_hour: { utilization: 95, resets_at: FIVE_HOUR_ISO } })),
      "five_hour",
    );

    expect(window.status).toBe("allowed_warning");
  });

  it("does not spend one window's measured status on another window", () => {
    // Hostile half: the memory is keyed by window kind. A `rejected` measured
    // for the 5-hour window must not blank out the weekly window, which was
    // never measured at all and is only a quarter used.
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(measured());

    const windows = tracker.windowsFrom(
      report({
        five_hour: { utilization: 25, resets_at: FIVE_HOUR_ISO },
        seven_day: { utilization: 25, resets_at: FIVE_HOUR_ISO },
      }),
    );

    expect(windowOfKind(windows, "five_hour").status).toBe("rejected");
    expect(windowOfKind(windows, "seven_day").status).toBe("allowed");
  });
});

describe("the memory ends when the window instance does (R1.6, R1.6.1)", () => {
  it("reports the derived status again once the reset instant has advanced", () => {
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(measured());

    const rolledOver = windowOfKind(
      tracker.windowsFrom(report(quietFiveHour(NEXT_WINDOW_ISO))),
      "five_hour",
    );

    // A refilled window that still reads `rejected` shows a user as blocked for
    // the life of the session — the defect R1.6's instance scoping exists for.
    expect(rolledOver.status).toBe("allowed");
    expect(rolledOver.resetsAt).toBe(NEXT_WINDOW_EPOCH);
  });

  it("does not resurrect the memory when a later report returns to the old instant", () => {
    // Hostile half of the rollover: once the instance ended, its measured status
    // is gone. An implementation that merely compared "is this instant equal to
    // the remembered one" without dropping the memory would pass the test above
    // and fail here.
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(measured());
    tracker.windowsFrom(report(quietFiveHour(NEXT_WINDOW_ISO)));

    const window = windowOfKind(tracker.windowsFrom(report(quietFiveHour())), "five_hour");

    expect(window.status).toBe("allowed");
  });

  it("uses the derived status where neither side carries a reset instant (R1.6.1)", () => {
    // No instant on the measured side: there is no instance to scope the memory
    // to, so none is kept and the derived status stands.
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(measured({ resetsAt: undefined }));

    const window = windowOfKind(tracker.windowsFrom(report(quietFiveHour(null))), "five_hour");

    expect(window.status).toBe("allowed");
    expect(window).not.toHaveProperty("resetsAt");
  });

  it("uses the derived status when the report's window carries no instant to match", () => {
    const tracker = new AccountUsageTracker();
    tracker.recordMeasured(measured());

    const window = windowOfKind(tracker.windowsFrom(report(quietFiveHour(null))), "five_hour");

    expect(window.status).toBe("allowed");
  });
});
