/**
 * Account quota transport — the structured `/usage` report mapped into the
 * `_meta["_claude/rateLimit"]` payload shape the installed Zed (patch `0011`,
 * `AccountUsage::ingest`) already ingests.
 *
 * The mapping is deliberately a pure module: no session, no SDK query, no I/O,
 * so the wire shape can be pinned by tests alone. `basename` is its only runtime
 * import, and `node:path` is a string module -- see `accountIdentity` for why that
 * matters and which test holds it to it.
 */

import { basename } from "node:path";

import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

/** Utilization at or above which a derived status becomes `allowed_warning`. 0..1. */
export const WARNING_THRESHOLD = 0.8;

/** The three values `0011`'s `AccountUsageStatus::from_wire` accepts. */
export type AccountUsageStatus = "allowed" | "allowed_warning" | "rejected";

/**
 * One payload in the `_meta["_claude/rateLimit"]` shape `AccountUsage::ingest` reads.
 * Field names are the WIRE names, not the report's snake_case ones.
 */
export type AccountQuotaWindow = {
  rateLimitType: string;
  status: AccountUsageStatus;
  /** 0..1, clamped. Omitted when the report carried none. */
  utilization?: number;
  /** Unix seconds. Omitted when the report's ISO instant would not parse. */
  resetsAt?: number;
  /** Server-supplied bucket name; present only on model-scoped windows. */
  displayName?: string;
  /** Emitted as `credits_required` only while a live event measured that state. */
  errorCode?: "credits_required";
  /** Emitted only once a live event has measured it. */
  isUsingOverage?: boolean;
};

/**
 * The one `errorCode` `0011` acts on -- it raises the "usage credits required"
 * warning. `satisfies` rather than a bare literal so the constant and the wire
 * type above cannot drift apart, and a plain literal in the type above rather
 * than a `typeof` query so this module-private name stays out of the published
 * declarations.
 */
const CREDITS_REQUIRED = "credits_required" satisfies AccountQuotaWindow["errorCode"];

/** The report states a utilization as a percentage; the wire carries a fraction. */
const PERCENT = 100;

/** The bounds of the 0..1 scale R1.9 names -- an empty bar and a full one. */
const UTILIZATION_FLOOR = 0;
const UTILIZATION_CEILING = 1;

/** Milliseconds per second: `Date.parse` answers in the former, the wire reads the latter. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * The shape the report's window entries share, widened so a malformed or missing
 * one can be read without throwing.
 *
 * Wider than the SDK's own declarations on purpose: `model_scoped[]` entries are
 * typed non-null there, `extra_usage` carries no `resets_at` at all, and the API
 * is experimental — "the response shape may change" is in its own doc comment.
 * A field that is absent, null or the wrong type must cost its window or that
 * one field, never an exception.
 */
type ReportedWindow = {
  utilization?: number | null;
  resets_at?: string | null;
  display_name?: string | null;
};

/** Where one emitted window comes from: the wire kind, and the report entry behind it. */
type WindowSource = [rateLimitType: string, entry: ReportedWindow | null | undefined];

/**
 * The plan windows, emitted in the order the report declares them.
 *
 * `seven_day_oauth_apps` has no kind in `0011`'s `from_wire` and is dropped by the
 * client today; it is emitted anyway, for the same reason `model_scoped` is — the
 * adapter's job is to carry what the report said, not to predict which client
 * version is listening.
 */
const PLAN_WINDOW_FIELDS = [
  "five_hour",
  "seven_day",
  "seven_day_oauth_apps",
  "seven_day_opus",
  "seven_day_sonnet",
] as const;

/** 0..100 -> 0..1, CLAMPED to [0,1]. undefined for null/undefined/non-finite. */
export function normalizeUtilization(value: number | null | undefined): number | undefined {
  // The client normalises defensively with `if v > 1.0 { v / 100.0 }`, so a window
  // at 1% passed through as `1` would fail that test and render as a FULL bar.
  // Dividing here is what keeps 1% and 100% two different numbers (D2, R1.9).
  //
  // CLAMPING here is what keeps the two normalisations from COMPOSING badly above
  // 100: a report of `137` divided once is `1.37`, which passes the client's
  // `> 1.0` test, is divided a second time, and draws a saturated window as a 1%
  // bar -- beside a row `deriveStatus` still coloured as a warning. Clamped, no
  // value we emit can exceed 1.0, so that heuristic can never fire and is a no-op
  // on every input. R1.9 asks for the 0..1 scale, and `1.37` is not on it.
  //
  // The lower bound is the same argument mirrored: a negative percentage is off
  // the scale too, and `0` is the honest floor for it.
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(Math.max(value / PERCENT, UTILIZATION_FLOOR), UTILIZATION_CEILING);
}

/** ISO 8601 -> Unix seconds (floored). undefined for null/undefined/unparseable. */
export function toEpochSeconds(value: string | null | undefined): number | undefined {
  // `0011` reads `resetsAt` with `as_i64()`: a string is dropped silently, taking
  // the reset time with it. Omitting the field is the honest failure (R1.10).
  if (typeof value !== "string") {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return undefined;
  }
  return Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
}

/** Derived status. NEVER `rejected` -- the adapter cannot know a request was refused. */
export function deriveStatus(utilization: number | undefined): "allowed" | "allowed_warning" {
  return utilization !== undefined && utilization >= WARNING_THRESHOLD
    ? "allowed_warning"
    : "allowed";
}

/**
 * How constrained each status is: `allowed` < `allowed_warning` < `rejected`.
 *
 * The order `0011`'s `most_constrained()` ranks by -- and it ranks by status BEFORE
 * utilization, so a status wrong by one step reorders the panel more than a
 * utilization wrong by half a bar.
 */
const CONSTRAINT_ORDER: Record<AccountUsageStatus, number> = {
  allowed: 0,
  allowed_warning: 1,
  rejected: 2,
};

/** Whether a value is one of the three statuses `0011`'s `from_wire` accepts. */
function isAccountUsageStatus(value: unknown): value is AccountUsageStatus {
  return typeof value === "string" && Object.hasOwn(CONSTRAINT_ORDER, value);
}

/** The stricter of two statuses; the first when they are equal. */
function moreConstrained(a: AccountUsageStatus, b: AccountUsageStatus): AccountUsageStatus {
  return CONSTRAINT_ORDER[a] >= CONSTRAINT_ORDER[b] ? a : b;
}

/**
 * A status a live `rate_limit_event` measured, scoped to the window instance it was
 * measured in.
 *
 * `resetsAt` is required here on purpose: an instance IS its reset instant, so a
 * measurement carrying none identifies no instance and is never remembered (R1.6.1).
 */
type MeasuredStatus = { status: AccountUsageStatus; resetsAt: number };

/**
 * The account-wide flags a live `rate_limit_event` measured, in wire shape.
 *
 * Account-wide, NOT per-window: `ingest` reads both BEFORE its `rateLimitType`
 * guard and stores them on the panel rather than on a bar. Every payload we send
 * therefore has to carry them, because `ingest` reads absent as FALSE, not as
 * unknown -- a window that omitted them would CLEAR the warning it was emitted
 * beside, and one report is one payload per window: five plan windows, one per
 * model bucket, and the overage.
 *
 * Picked from the wire type rather than restated: what is remembered here is
 * exactly what is re-emitted, so the two cannot drift.
 */
type MeasuredAccountFlags = Pick<AccountQuotaWindow, "errorCode" | "isUsingOverage">;

/**
 * Whether a live event says overage is in use, or undefined when it says nothing.
 *
 * Both spellings are read, in the client's own order -- `ingest` takes
 * `isUsingOverage` and falls back to `overageInUse`, and the SDK declares the two
 * as separate optional fields. Anything that is not a boolean is no measurement at
 * all, so it falls through rather than becoming a `false` nobody reported.
 */
function measuredOverage(info: SDKRateLimitInfo): boolean | undefined {
  if (typeof info.isUsingOverage === "boolean") {
    return info.isUsingOverage;
  }
  if (typeof info.overageInUse === "boolean") {
    return info.overageInUse;
  }
  return undefined;
}

/**
 * The account-wide flags one live event measured; empty when it measured neither.
 *
 * `errorCode` is compared against the one value `0011` acts on rather than copied:
 * the field is declared with a single member, so any other string is a state this
 * client has no rendering for, and forwarding it would only widen the wire.
 */
function measuredFlagsOf(info: SDKRateLimitInfo): MeasuredAccountFlags {
  const isUsingOverage = measuredOverage(info);
  return {
    ...(info.errorCode === CREDITS_REQUIRED && { errorCode: CREDITS_REQUIRED }),
    ...(isUsingOverage !== undefined && { isUsingOverage }),
  };
}

/** The default configuration directory's own name -- where it lives, not what it is called. */
const DEFAULT_CONFIG_DIR_NAME = ".claude";

/** What the default profile is labelled, in place of the directory name above. */
const DEFAULT_PROFILE_NAME = "default";

/** Between the two halves of an identity: U+00B7 MIDDLE DOT, spaced. */
const IDENTITY_SEPARATOR = " \u00b7 ";

/**
 * The profile a configuration directory names: its basename, with the default
 * directory reported as `default` rather than as the `.claude` it happens to be
 * stored in (D7, R2.2). Empty string when the directory names no profile.
 *
 * `basename` rather than a hand-rolled split: it is a pure string function, it drops
 * a trailing separator, and it reads the platform's own separator -- which a split on
 * `/` would not. It is also what built the directory in the first place
 * (`acp-agent.ts`'s `CLAUDE_CONFIG_DIR`), so the two agree by construction.
 *
 * The empty cases are reachable, not theoretical: `CLAUDE_CONFIG_DIR` is an env var,
 * and `??` does not catch a variable that is SET BUT EMPTY. `basename("")` and
 * `basename("/")` are both `""`, and an empty profile costs that half of the identity
 * rather than throwing.
 */
function profileName(configDir: string): string {
  // Trimming a LABEL, never a path: nothing here is opened, so whitespace around the
  // name is noise in the panel and nothing else. Trimmed before the comparison so a
  // stray trailing space in the env var still resolves to the default profile.
  const profile = basename(configDir).trim();
  return profile === DEFAULT_CONFIG_DIR_NAME ? DEFAULT_PROFILE_NAME : profile;
}

/**
 * `<subscription> · <profile>`, or the profile alone when no subscription type.
 *
 * Both halves are already in hand: the subscription type arrives in the structured
 * usage report (R2.1) and the profile is a string operation on the configuration
 * directory the session was started with (R2.2).
 *
 * NO FILE IS OPENED TO BUILD THIS. The account e-mail is what the VS Code extension
 * shows and it is the more informative label, but it lives in `.credentials.json`, and
 * reading it would carry credential material through `_meta` over ACP and into every
 * log that records a notification (D7, R2.3).
 *
 * The directory arrives as a PARAMETER rather than being read from `CLAUDE_CONFIG_DIR`
 * directly: that constant lives in `acp-agent.ts`, which already imports this module,
 * so importing it back would both close a cycle and cost this module its purity.
 */
export function accountIdentity(
  subscriptionType: string | null | undefined,
  configDir: string,
): string {
  // `subscription_type` is `string | null` on an API whose own doc comment says the
  // shape may change, so it is read as it arrives rather than as it is declared.
  const subscription = typeof subscriptionType === "string" ? subscriptionType.trim() : "";
  const profile = profileName(configDir);
  // R2.4: an API-key, Bedrock or Vertex session carries no subscription type, and the
  // identity then degrades to the profile alone rather than disappearing. Joining only
  // the halves that exist covers the other side of that -- an unnameable profile -- with
  // the same line, and leaves an empty identity as the only answer when neither half is
  // available, which is the honest one.
  return [subscription, profile].filter((half) => half.length > 0).join(IDENTITY_SEPARATOR);
}

/**
 * One report entry as one wire payload, or undefined when the report carried no
 * entry for that window.
 *
 * A window whose `utilization` is null is still emitted with the field omitted:
 * R1.4 asks for the utilization *when the report supplies one*, and `0011` renders
 * an absent utilization as an em dash, where a zero would claim the window is
 * untouched rather than unmeasured.
 */
function toQuotaWindow(
  rateLimitType: string,
  entry: ReportedWindow | null | undefined,
): AccountQuotaWindow | undefined {
  if (entry === null || entry === undefined) {
    return undefined;
  }
  const utilization = normalizeUtilization(entry.utilization);
  const resetsAt = toEpochSeconds(entry.resets_at);
  const displayName = typeof entry.display_name === "string" ? entry.display_name : undefined;
  return {
    rateLimitType,
    status: deriveStatus(utilization),
    ...(utilization !== undefined && { utilization }),
    ...(resetsAt !== undefined && { resetsAt }),
    ...(displayName !== undefined && { displayName }),
  };
}

/**
 * Maps structured usage reports to quota-window payloads, remembering a status
 * measured by a live `rate_limit_event` for the life of that window instance, and
 * the account-wide flags such an event carries until another event changes them.
 */
export class AccountUsageTracker {
  /**
   * The status last measured for each wire `rateLimitType`, for as long as the
   * instance it was measured in lasts.
   */
  private readonly measured = new Map<string, MeasuredStatus>();

  /**
   * What the last live event said about the account as a whole. Empty until one
   * has said anything -- which leaves both keys off every payload, and `ingest`
   * defaulting them to false exactly as it did before this transport existed.
   */
  private measuredFlags: MeasuredAccountFlags = {};

  /** Record a status measured by a live rate-limit event (D4 part 2). */
  recordMeasured(info: SDKRateLimitInfo): void {
    // Read BEFORE the guard below, mirroring `ingest`, which reads the same two
    // flags before its own `rateLimitType` guard: an event that names no window
    // still carries the account-wide state, and an event whose kind this client
    // drops is exactly the kind that announces one.
    //
    // Overwritten WHOLESALE, because a live event is the only thing that may
    // clear these. An event carrying no `errorCode` clears `credits_required`
    // here exactly as it would have on ingest; `windowsFrom` re-asserts what was
    // last measured and never clears on its own.
    this.measuredFlags = measuredFlagsOf(info);
    const { rateLimitType, resetsAt, status } = info;
    // All three are read as they arrive, so none may be assumed well formed:
    // `rateLimitType` and `resetsAt` are optional on the wire, and `status` is only
    // required by a declaration, not by the sender. Without the kind there is no
    // window to attach the status to; without the reset instant there is no instance
    // to scope it to (R1.6.1); a status `0011` would not parse costs the whole window
    // on ingest. Any of the three missing means no memory, and the derived status
    // then stands -- which is the honest answer, not a degraded one.
    if (
      typeof rateLimitType !== "string" ||
      typeof resetsAt !== "number" ||
      !Number.isFinite(resetsAt) ||
      !isAccountUsageStatus(status)
    ) {
      return;
    }
    this.measured.set(rateLimitType, { status, resetsAt });
  }

  /**
   * The status one derived window should carry: its own, unless a status measured for
   * that same instance is more constrained (R1.6).
   *
   * A rollover DELETES the memory rather than merely declining to apply it. Comparing
   * instants alone would let a later report naming the old instant again resurrect a
   * status whose instance has already ended.
   */
  private statusFor(window: AccountQuotaWindow): AccountUsageStatus {
    // What the window carries at this point is the DERIVED status; naming it says so.
    const derived = window.status;
    const instant = window.resetsAt;
    const remembered = this.measured.get(window.rateLimitType);
    if (remembered === undefined || instant === undefined) {
      return derived;
    }
    if (instant > remembered.resetsAt) {
      this.measured.delete(window.rateLimitType);
      return derived;
    }
    // An EARLIER instant is a report from before the measurement, not a new instance:
    // it neither matches the remembered one nor ends it, so the memory is kept for the
    // report that does match.
    if (instant < remembered.resetsAt) {
      return derived;
    }
    // R1.6 forbids reporting LESS constrained than measured -- it does not license
    // softening a window that has since crossed the warning threshold back down to an
    // `allowed` measured earlier in the same instance.
    return moreConstrained(derived, remembered.status);
  }

  /**
   * Every window the report carries, in wire shape. Empty list when
   * `rate_limits_available` is false or `rate_limits` is null.
   */
  windowsFrom(report: SDKControlGetUsageResponse): AccountQuotaWindow[] {
    // R1.5: the flag governs, not the presence of data. A report can carry a
    // populated `rate_limits` while declaring the limits inapplicable, and a
    // section of bars then states the account is unused rather than unmeasured.
    if (!report.rate_limits_available) {
      return [];
    }
    const limits = report.rate_limits;
    if (limits === null || limits === undefined) {
      return [];
    }

    const sources: WindowSource[] = PLAN_WINDOW_FIELDS.map((field) => [field, limits[field]]);
    // Every model-scoped entry, kept as its own payload: they share one
    // `rateLimitType`, so the display name and the number are the only things
    // telling two of them apart (R1.11).
    for (const entry of limits.model_scoped ?? []) {
      sources.push(["model_scoped", entry]);
    }
    // `extra_usage` is a quota window only once overage is switched on; disabled,
    // its numbers describe a limit nobody is spending against. It carries no
    // reset instant, so the emitted window has no `resetsAt`.
    const extraUsage = limits.extra_usage;
    if (extraUsage?.is_enabled === true) {
      sources.push(["overage", extraUsage]);
    }

    const windows: AccountQuotaWindow[] = [];
    for (const [rateLimitType, entry] of sources) {
      const window = toQuotaWindow(rateLimitType, entry);
      if (window !== undefined) {
        window.status = this.statusFor(window);
        // The flags ride EVERY window: they describe the account, and `ingest`
        // reads them off whichever payload it is handed. Repeating them is
        // idempotent -- `ingest` compares before assigning, so only the first
        // payload of a report can report a change.
        windows.push({ ...window, ...this.measuredFlags });
      }
    }
    return windows;
  }
}
