import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

/**
 * Model deprecation heuristic.
 *
 * The Claude Agent SDK's `ModelInfo` (0.3.204) exposes NO deprecation flag —
 * its only capability fields are `supportsEffort` / `supportedEffortLevels`,
 * `supportsAdaptiveThinking`, `supportsFastMode`, and `supportsAutoMode`. There
 * is therefore no authoritative, machine-readable signal telling a host that a
 * model row has been retired.
 *
 * As a stand-in this module scans the human-facing copy — `displayName` and
 * `description` — for the words "deprecated" or "legacy" (case-insensitive).
 * This is deliberately a HEURISTIC: it can only catch models the SDK happens to
 * label in prose, and it is intentionally scoped to those two fields. The
 * opaque model id in `value` is NEVER inspected, because ids routinely embed
 * version/family slugs (e.g. a "legacy"-like substring) that do not indicate an
 * actually deprecated model and would produce false positives.
 *
 * When the SDK gains a real deprecation flag, replace this heuristic with a
 * direct field read.
 *
 * @module model-deprecation
 */

/** Case-insensitive marker words the SDK uses in prose for retired models. */
const DEPRECATION_MARKER = /deprecated|legacy/i;

/**
 * Heuristically decide whether a model row is deprecated.
 *
 * Matches {@link DEPRECATION_MARKER} (`/deprecated|legacy/i`) over `displayName`
 * and `description` ONLY. The `value` (model id) is never inspected — an id that
 * merely contains a "legacy"-like slug must NOT flag the row. A missing,
 * `undefined`, or empty `displayName` or `description` is treated as an empty
 * string, so this never throws.
 *
 * See the module doc for WHY this is a heuristic (SDK 0.3.204 `ModelInfo` has no
 * deprecation field).
 *
 * @param info - A single SDK model row.
 * @returns `true` when the display copy marks the model deprecated/legacy.
 */
export function isDeprecatedModel(info: ModelInfo): boolean {
  const displayName = info.displayName ?? "";
  const description = info.description ?? "";
  return DEPRECATION_MARKER.test(`${displayName} ${description}`);
}

/**
 * Return a NEW array with deprecated rows removed.
 *
 * Kept rows preserve their original order AND identity — the same object
 * references are returned, not copies. Built on {@link isDeprecatedModel}, so it
 * shares that function's heuristic and field scoping. An empty input yields an
 * empty array.
 *
 * @param infos - The model catalog to filter.
 * @returns A new array containing only the non-deprecated rows.
 */
export function filterDeprecatedModels(infos: ModelInfo[]): ModelInfo[] {
  return infos.filter((info) => !isDeprecatedModel(info));
}
