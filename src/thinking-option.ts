/**
 * "Thinking" session config option (story 006, R1.1/R1.4/R1.5/R1.6): the
 * select-option factory surfaced via `configOptions`, the value resolver for
 * `session/set_config_option`, and the ONE precedence point that combines the
 * session's thinking intent with the legacy `MAX_THINKING_TOKENS` env
 * resolution into the SDK's `thinking` option.
 *
 * Kept self-contained (no import from the daily-churning `acp-agent.ts`,
 * mirroring the `ask-user-question-fallback.ts` precedent) so the logic is
 * unit-testable in isolation; `acp-agent.ts` wires it into
 * `buildConfigOptions`/`setSessionConfigOption`/query creation in sub-tasks
 * 1.2/1.3.
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";

/** Stable id for the Thinking session config option. */
export const THINKING_CONFIG_ID = "thinking";
/** Select value that turns extended thinking on. */
export const THINKING_ON = "on";
/** Select value that turns extended thinking off. */
export const THINKING_OFF = "off";
const THINKING_DESCRIPTION = "Extended thinking before responding";

/**
 * Minimal logging surface this module needs — structurally compatible with
 * acp-agent's `Logger` (`{ log, error }`), declared locally so the module
 * stays free of `acp-agent.ts` imports.
 */
export interface ThinkingLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Build the Thinking config option: a two-value "on"/"off" `select` in the
 * exact shape of the Fast mode select fallback (R1.1). Unlike Fast mode there
 * is no boolean variant — the option is select-only from day one.
 *
 * @param enabled Whether extended thinking is currently on for the session;
 *   reflected in `currentValue`.
 */
export function createThinkingConfigOption(enabled: boolean): SessionConfigOption {
  return {
    id: THINKING_CONFIG_ID,
    name: "Thinking",
    description: THINKING_DESCRIPTION,
    category: "model_config",
    type: "select",
    currentValue: enabled ? THINKING_ON : THINKING_OFF,
    options: [
      { value: THINKING_ON, name: "On" },
      { value: THINKING_OFF, name: "Off" },
    ],
  };
}

/**
 * Resolve a `session/set_config_option` value for the Thinking option into the
 * session's thinking intent. Only the select values are meaningful: `"on"` →
 * `true`, `"off"` → `false`. Anything else — booleans included, since the
 * option never had a legacy boolean shape (unlike Fast mode) — resolves to
 * `null` (unrecognized).
 *
 * @param value Raw value from the request (untrusted; narrowed here).
 */
export function resolveThinkingSelection(value: unknown): boolean | null {
  if (value === THINKING_ON) return true;
  if (value === THINKING_OFF) return false;
  return null;
}

/**
 * Translate the legacy `MAX_THINKING_TOKENS` env var into the SDK's `thinking`
 * option: unset → `undefined` (SDK default, adaptive on models that support
 * it); `0` → disabled; a positive integer → a fixed token budget. Anything
 * else is ignored with a logged error, i.e. treated as unset.
 *
 * NOTE: duplicated from the unexported `resolveThinkingConfig` in
 * `acp-agent.ts` (behavior and log message identical); sub-task 1.3 makes
 * `acp-agent.ts` consume this export and removes the duplication.
 *
 * @param raw The raw `MAX_THINKING_TOKENS` value (pass
 *   `process.env.MAX_THINKING_TOKENS`).
 * @param logger Sink for the invalid-value error.
 */
export function resolveThinkingConfig(
  raw: string | undefined,
  logger: ThinkingLogger,
): ThinkingConfig | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    logger.error(`Ignoring MAX_THINKING_TOKENS: expected a non-negative integer, got '${raw}'.`);
    return undefined;
  }
  return parsed === 0 ? { type: "disabled" } : { type: "enabled", budgetTokens: parsed };
}

/**
 * The ONE precedence point combining the session's Thinking intent with the
 * legacy `MAX_THINKING_TOKENS` env resolution:
 *
 * - `intent === false` → `{ type: "disabled" }`, the SDK's documented
 *   no-extended-thinking value — the option beats the env var (R1.5).
 * - `intent === true` → the env resolution when the env var is set (R1.4);
 *   with the env var unset — or invalid, which is logged and treated as unset
 *   — the SDK's documented enabled default `{ type: "adaptive" }` ("Claude
 *   decides when and how much to think").
 * - `intent === undefined` → exactly today's env-driven behavior, including
 *   `undefined` (SDK default) when the env var is unset (R1.6).
 *
 * @param intent The session's Thinking selection: `true`/`false` once the
 *   client has set the option, `undefined` while untouched.
 * @param env The raw `MAX_THINKING_TOKENS` value (pass
 *   `process.env.MAX_THINKING_TOKENS`).
 * @param logger Sink for the invalid-env error.
 */
export function effectiveThinkingConfig(
  intent: boolean | undefined,
  env: string | undefined,
  logger: ThinkingLogger,
): ThinkingConfig | undefined {
  if (intent === false) return { type: "disabled" };
  if (intent === true) return resolveThinkingConfig(env, logger) ?? { type: "adaptive" };
  return resolveThinkingConfig(env, logger);
}
