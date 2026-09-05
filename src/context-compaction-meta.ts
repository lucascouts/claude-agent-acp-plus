/**
 * The versioned `_meta` extension that carries context-compaction facts on the
 * synthetic ACP tool call (story 010, R2.1/D3).
 *
 * Why an extension rather than the protocol's own variant: ACP 1.4 does define
 * a `compaction_update`, but the Rust crate the packaged Zed links
 * (`agent-client-protocol 2.0.0`) carries no `compaction` symbol at all, so
 * that variant cannot be deserialised no matter what this adapter sends. The
 * reachable pattern is the one downstream patch `0011` already proves: emit a
 * `_meta` key no ACP variant claims, and let a downstream patch read it. The
 * tool call renders with `ToolKind::Think`'s icon even with no patch present,
 * so R2.1 ships and works on its own.
 *
 * Why the version field is not optional (D3): it is what makes the two halves
 * independently releasable in BOTH directions — a newer adapter against an
 * older Zed degrades to generic tool rendering, and an older adapter against a
 * newer Zed simply never sends the key. A payload with no version is a payload
 * a reader cannot degrade from, so it can only be guessed at.
 *
 * Kept self-contained — no import from `acp-agent.ts`, mirroring
 * `thinking-option.ts` and `rewind-command.ts`. The reason is merge cost:
 * `acp-agent.ts` is a ~9,700-line file that changes upstream almost daily, so
 * every coupling to it is paid again at each sync.
 */

/** The `_meta` key the downstream Zed patch looks for. */
export const CONTEXT_COMPACTION_META_KEY = "contextCompaction";

/**
 * Schema version of the payload under {@link CONTEXT_COMPACTION_META_KEY}.
 * Bump it whenever a field's meaning changes; a reader that does not know the
 * value it receives must fall back to generic tool rendering rather than
 * interpret unknown fields.
 */
export const CONTEXT_COMPACTION_META_VERSION = 1;

/**
 * Why the compaction ran: `"manual"` for a user-issued `/compact`,
 * `"automatic"` when the SDK compacted on its own to stay inside the window.
 * Provider-neutral by design — the SDK spells the automatic case `"auto"`.
 */
export type ContextCompactionTrigger = "manual" | "automatic";

/**
 * Compaction-specific facts carried alongside the tool call. Every field
 * except `version` is optional because the SDK frame that produced the event
 * may not carry it: a terminal-only `status` message has no token counts, and
 * an older CLI's `compact_boundary` omits `post_tokens`/`duration_ms`.
 */
export interface ContextCompactionMetadata {
  /** Always {@link CONTEXT_COMPACTION_META_VERSION}; see D3 above. */
  version: typeof CONTEXT_COMPACTION_META_VERSION;
  /** Manual `/compact` or an automatic window-pressure compaction. */
  trigger?: ContextCompactionTrigger;
  /** Tokens occupying the context window before compaction. */
  preTokens?: number;
  /** Tokens occupying it after — absent on CLIs that don't report it. */
  postTokens?: number;
  /** How long the compaction took, in milliseconds. */
  durationMs?: number;
  /** Failure reason, present only on a `failed` lifecycle. */
  error?: string;
}

/**
 * Provider-neutral metadata for a synthetic ACP context-compaction tool call.
 *
 * The standard `toolCallId` and `status` fields own lifecycle identity and
 * phase; this extension deliberately carries only compaction-specific facts,
 * so a client that ignores `_meta` entirely still sees a correct tool
 * lifecycle.
 *
 * @param metadata The facts known at this point in the lifecycle; the version
 *   is stamped here rather than by each call site, so no caller can emit an
 *   unversioned payload.
 */
export function createContextCompactionMeta(
  metadata: Omit<ContextCompactionMetadata, "version"> = {},
): Record<typeof CONTEXT_COMPACTION_META_KEY, ContextCompactionMetadata> {
  return {
    [CONTEXT_COMPACTION_META_KEY]: {
      version: CONTEXT_COMPACTION_META_VERSION,
      ...metadata,
    },
  };
}
