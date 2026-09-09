/**
 * One quota sample per machine per interval, shared between adapter processes.
 *
 * The plan windows are a fact about an ACCOUNT, but they were fetched per
 * SESSION. On a desktop running ten Zed windows that is ten identical control
 * requests per interval for one number -- and, worse, ten samples taken at ten
 * different instants. The number genuinely moves between them (other sessions
 * consume, and old requests age out of the five-hour window), so every window
 * showed a different, individually truthful percentage. Measured 2026-09-09:
 * one instance at 15% beside two at 19%, and `five_hour` observed going
 * 0.15 -> 0.18 -> 0.15 inside two minutes with nothing prompted.
 *
 * Shortening the interval makes that WORSE, not better: it samples the moving
 * number more often. Agreement has to come from sharing the sample, not from
 * hoping the clocks line up.
 *
 * What is cached is the REPORT's two rate-limit fields, never the derived
 * windows. `AccountUsageTracker.statusFor` applies a status this session
 * measured from its own live `rate_limit_event` (R1.6), and that memory is
 * session-scoped by design -- caching the derived windows would hand one
 * session's measured `rejected` to another. Caching the raw fields lets every
 * session derive its own.
 *
 * Everything here fails soft. A cache that cannot be read or written is a cache
 * miss, never an error: the refresh it exists to cheapen must still happen.
 */

import { createHash, randomUUID } from "node:crypto";

import type { QuotaLimitsReport } from "./account-usage.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The two fields `windowsFrom` reads. Nothing else is cached -- the report also
 *  carries this session's cost and token totals, which are nobody else's. */
export type CachedLimits = QuotaLimitsReport;

type CacheFile = CachedLimits & { fetchedAt: number };

/**
 * A cache is only shareable between processes answering for the SAME account.
 *
 * The api-key entry is the case that makes this mandatory rather than tidy: a
 * session authenticated by `ANTHROPIC_API_KEY` reports `rate_limits_available:
 * false` and no windows at all. Sharing one file with a subscription session
 * would let it publish that emptiness to every other window on the desktop.
 *
 * The key is a digest. The API key itself is hashed before it contributes, so
 * two different keys cannot collide while neither appears in a filename.
 */
function scopeKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const scope = [
    process.env.ANTHROPIC_CONFIG_DIR ?? "",
    process.env.CLAUDE_CONFIG_DIR ?? "",
    apiKey ? createHash("sha256").update(apiKey).digest("hex") : "",
  ].join("\0");
  return createHash("sha256").update(scope).digest("hex").slice(0, 16);
}

/**
 * How old a shared sample may be and still be used, for a given tick interval.
 *
 * Deliberately SHORTER than the interval. Equal, and whether a process re-fetches
 * on its own tick turns on sub-millisecond timing: its own sample is then exactly
 * one interval old at the boundary, so a write that landed a hair late reads as
 * fresh and the tick silently skips. Nothing breaks -- the data is still within
 * an interval -- but the behaviour stops being predictable, and a test that
 * asserts it becomes a coin toss.
 *
 * At nine tenths both cases are decided by a wide margin: a process's OWN last
 * sample is reliably stale at its next tick, and a sample another process took
 * mid-interval is reliably fresh. The account is still sampled about once per
 * interval, which is the whole point.
 */
export function sharedSampleMaxAgeMs(intervalMs: number): number {
  return Math.floor(intervalMs * 0.9);
}

/** `XDG_RUNTIME_DIR` is the right home: per-user, mode 0700, on tmpfs, and
 *  cleared at logout, so a stale sample can never outlive the desktop that
 *  produced it. `tmpdir()` is the fallback for hosts without it, where the mode
 *  on the file itself is what protects the sample. */
export function quotaCachePath(): string {
  const dir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(dir, `claude-acp-quota-${scopeKey()}.json`);
}

/**
 * The cached sample, when it is younger than `maxAgeMs`; `null` otherwise.
 *
 * `null` is returned for every failure too -- missing file, unparseable JSON,
 * a clock that moved backwards. The caller's contract is "fetch on null", so a
 * broken cache degrades to exactly the behaviour that existed before it.
 */
export async function readFreshLimits(
  maxAgeMs: number,
  now: number = Date.now(),
): Promise<CachedLimits | null> {
  try {
    const raw = await fs.readFile(quotaCachePath(), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (typeof parsed?.fetchedAt !== "number") {
      return null;
    }
    const age = now - parsed.fetchedAt;
    // A negative age means the writer's clock is ahead of ours. Treat it as a
    // miss rather than as infinitely fresh, which would pin every window to one
    // sample until the clocks reconciled.
    if (age < 0 || age >= maxAgeMs) {
      return null;
    }
    return {
      rate_limits_available: parsed.rate_limits_available,
      rate_limits: parsed.rate_limits,
    };
  } catch {
    return null;
  }
}

/**
 * Publish a freshly fetched sample for the other processes.
 *
 * Written to a per-pid temp file and renamed, because `rename(2)` is atomic
 * within a directory: a reader either sees the whole previous sample or the
 * whole new one, never a half-written file. Two processes racing produces two
 * fetches and one surviving sample, which is the harmless outcome -- the reads
 * are idempotent and the loser's work is simply discarded.
 */
export async function writeLimits(limits: CachedLimits, now: number = Date.now()): Promise<void> {
  const target = quotaCachePath();
  // Unique per WRITE, not per process. One adapter process serves several
  // sessions, so a turn ending in one can coincide with another's tick: sharing
  // a temp path by pid let two writes interleave into it, and `rename` then
  // published the mixture. The corrupt file parsed as a miss, so the damage was
  // silent -- every reader simply fetched, and the cache quietly did nothing.
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const body: CacheFile = {
    fetchedAt: now,
    rate_limits_available: limits.rate_limits_available,
    rate_limits: limits.rate_limits,
  };
  try {
    await fs.writeFile(temp, JSON.stringify(body), { mode: 0o600 });
    await fs.rename(temp, target);
  } catch {
    // A sample that could not be shared is not a failed refresh: this process
    // already has the answer and is about to publish it to its own client.
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
