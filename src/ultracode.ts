/**
 * The "Ultracode" entry of the Effort picker.
 *
 * **Ultracode is not a sixth effort level, and reading it as one produces the
 * wrong control.** Claude Code's VS Code extension models it as a boolean that
 * turns on two things at once — `xhigh` effort *and* standing dynamic-workflow
 * orchestration — and its own tooltip says so: `"Ultracode - xhigh +
 * workflows"`. Its five real levels are `low` `medium` `high` `xhigh` `max`;
 * Ultracode is drawn as one extra notch past the last of them, styled
 * differently, and selecting any ordinary level clears it.
 *
 * ACP has no compound control to carry that, so the adapter projects it the way
 * the extension's UI reads rather than the way its state is stored: one more
 * entry in the `effort` select. The compound stays here, in one module, instead
 * of being spread across the three places `acp-agent.ts` applies effort.
 *
 * The SDK carries both halves and names the channel: `Settings.ultracode` is
 * *"xhigh effort plus standing dynamic-workflow orchestration. Session-scoped —
 * typically provided via --settings or the apply_flag_settings control
 * request"*. `apply_flag_settings` is already how the effort option is applied,
 * so no new transport is involved.
 *
 * Kept self-contained — no import from `acp-agent.ts` — for the reason
 * `thinking-option.ts` and `rewind-command.ts` state: that file is ~9,900 lines
 * and moves upstream almost daily, so every coupling to it is paid again at
 * each sync.
 */

import type { EffortLevel, Settings } from "@anthropic-ai/claude-agent-sdk";

/** Value of the synthetic "Ultracode" entry in the effort picker. It is a
 *  reserved sentinel: no `EffortLevel` is spelled this way, so it cannot
 *  collide with a level the SDK reports in `supportedEffortLevels`. */
export const ULTRACODE_OPTION_VALUE = "ultracode";

/** Display name of that entry, matching the extension's own label. */
export const ULTRACODE_OPTION_NAME = "Ultracode";

/** The effort level Ultracode implies. Not configurable: the extension hardcodes
 *  `xhigh` in `enableUltracode()`, and the SDK's own description of the setting
 *  names the same level. A different level here would silently mean something
 *  else than it does in the reference client. */
export const ULTRACODE_EFFORT_LEVEL: EffortLevel = "xhigh";

/** Display state for the Ultracode entry, resolved by the caller. Mirrors the
 *  shape `FastModeOptionState` uses for the same job — availability and current
 *  value are two different questions, and folding them into one boolean loses
 *  the case where the entry should render but not be selected. */
export interface UltracodeOptionState {
  /** Whether the entry should appear at all. */
  available: boolean;
  /** Whether it is the currently selected effort. */
  enabled: boolean;
}

/**
 * Whether the Ultracode entry may be offered, under the same two conditions the
 * extension checks in its own `ultracodeAvailable`:
 *
 * 1. workflows are not disabled — Ultracode *is* the workflow half, so offering
 *    it where `disableWorkflows` is set would advertise something that cannot
 *    happen;
 * 2. the current model supports `xhigh` — Ultracode has no meaning on a model
 *    that cannot reach the level it implies.
 *
 * Both are read rather than assumed: an unknown settings shape leaves
 * `disableWorkflows` undefined, which is *not* `true`, so the gate opens — the
 * same direction the extension's `=== !0` comparison takes.
 */
export function isUltracodeAvailable(
  supportedEffortLevels: readonly string[],
  settings: Pick<Settings, "disableWorkflows"> | undefined,
): boolean {
  if (settings?.disableWorkflows === true) return false;
  return supportedEffortLevels.includes(ULTRACODE_EFFORT_LEVEL);
}

/** Whether a picker value denotes Ultracode rather than a plain effort level. */
export function isUltracodeValue(value: string | undefined): boolean {
  return value === ULTRACODE_OPTION_VALUE;
}

/**
 * The `apply_flag_settings` payload for an effort selection, Ultracode included.
 *
 * **The `null` is the load-bearing part.** The SDK shallow-merges flag settings
 * and only clears a key when an explicit `null` arrives — `undefined` is dropped
 * by JSON transport and leaves the previous value standing. So every selection
 * has to say something about `ultracode`, not just the one that turns it on:
 * without the clear, picking `High` after Ultracode would lower the effort and
 * leave workflow orchestration running, which is a state no picker entry names.
 * The same reasoning applies to `effortLevel` — this function absorbed the older
 * `toSdkEffortLevel` helper for exactly that reason: both keys are decided in
 * one place, so neither can be forgotten on a path the other takes.
 *
 * @param value the picker value — `"default"`, an `EffortLevel`, or the
 *   Ultracode sentinel. `undefined` means the option is absent for this model.
 */
export function ultracodeFlagSettings(value: string | undefined): {
  effortLevel: EffortLevel | null;
  ultracode: boolean | null;
} {
  if (isUltracodeValue(value)) {
    return { effortLevel: ULTRACODE_EFFORT_LEVEL, ultracode: true };
  }
  return {
    effortLevel: value === undefined || value === "default" ? null : (value as EffortLevel),
    ultracode: null,
  };
}

/**
 * The picker value to display, given the persisted effort level and whether the
 * Ultracode flag is on.
 *
 * The flag wins over the level, and only when it is *available*: a session that
 * carries `ultracode: true` from settings while the current model cannot reach
 * `xhigh` must not show an entry the picker is not rendering. The extension
 * reaches the same state through `adoptAppliedEffort`, which reads
 * `applied.ultracode` first and falls back to inferring it from `xhigh`; we do
 * not infer, because `xhigh` alone is a legitimate selection that is not
 * Ultracode, and guessing would silently turn workflows on in the label.
 */
export function effortOptionValue(
  effortLevel: string | undefined,
  ultracode: UltracodeOptionState | undefined,
): string | undefined {
  if (ultracode?.available && ultracode.enabled) return ULTRACODE_OPTION_VALUE;
  return effortLevel;
}
