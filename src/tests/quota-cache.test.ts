import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  quotaCachePath,
  readFreshLimits,
  sharedSampleMaxAgeMs,
  writeLimits,
} from "../quota-cache.js";

/**
 * The shared quota sample.
 *
 * Contract: one fetch per machine per interval, so separate adapter processes
 * publish the SAME numbers instead of each sampling a moving value at its own
 * instant. Every failure mode degrades to a cache miss, because the caller's
 * contract is "fetch on null" and a broken cache must not be worse than no
 * cache at all.
 */

const LIMITS = {
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 0.42 } },
} as never;

let dir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "quota-cache-"));
  savedEnv = {
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_CONFIG_DIR: process.env.ANTHROPIC_CONFIG_DIR,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.XDG_RUNTIME_DIR = dir;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a sample is shared between processes, or it is a miss", () => {
  it("round-trips a sample that is still fresh", async () => {
    await writeLimits(LIMITS, 1_000);
    expect(await readFreshLimits(60_000, 30_000)).toEqual(LIMITS);
  });

  it("misses once the sample is older than the window asked for", async () => {
    await writeLimits(LIMITS, 1_000);
    expect(await readFreshLimits(60_000, 61_000)).toBeNull();
  });

  it("misses when the writer's clock is ahead of ours", async () => {
    await writeLimits(LIMITS, 90_000);
    // Treating a negative age as fresh would pin every window to one sample
    // until the clocks reconciled -- which could be never.
    expect(await readFreshLimits(60_000, 10_000)).toBeNull();
  });

  it("misses on a missing file rather than throwing", async () => {
    expect(await readFreshLimits(60_000)).toBeNull();
  });

  it("misses on a corrupt file rather than throwing", async () => {
    await fs.writeFile(quotaCachePath(), "{ this is not json");
    expect(await readFreshLimits(60_000)).toBeNull();
  });

  it("misses when the file parses but carries no timestamp", async () => {
    await fs.writeFile(quotaCachePath(), JSON.stringify({ rate_limits: {} }));
    expect(await readFreshLimits(60_000)).toBeNull();
  });

  it("persists the two rate-limit fields and nothing else", async () => {
    // The report also carries THIS session's cost and token totals. Sharing a
    // file must not share those: they belong to one session, not the account.
    await writeLimits(
      {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 0.42 } },
        session: { cost_usd: 1.23 },
      } as never,
      1_000,
    );
    const raw = JSON.parse(await fs.readFile(quotaCachePath(), "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["fetchedAt", "rate_limits", "rate_limits_available"]);
  });

  it("survives two writers in one process without corrupting the file", async () => {
    // One adapter process serves several sessions, so a turn ending in one can
    // land on another's tick. A temp path shared by pid let the two interleave
    // and `rename` published the mixture -- which parsed as a miss, so the cache
    // silently stopped working instead of failing.
    const big = {
      rate_limits_available: true,
      rate_limits: {
        seven_day: { utilization: 42, resets_at: null, display_name: "x".repeat(400) },
      },
    } as never;
    const small = {
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 1 } },
    } as never;

    await Promise.all([
      writeLimits(big, 1_000),
      writeLimits(small, 1_000),
      writeLimits(big, 1_000),
      writeLimits(small, 1_000),
    ]);

    const raw = await fs.readFile(quotaCachePath(), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(await readFreshLimits(60_000, 1_500)).not.toBeNull();
  });

  it("leaves no temp file behind", async () => {
    await writeLimits(LIMITS, 1_000);
    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("an API-key session does not share at all", () => {
  it("reads nothing, even from a sample that is there and fresh", async () => {
    await writeLimits(LIMITS, 1_000);
    expect(await readFreshLimits(60_000, 1_500)).toEqual(LIMITS);

    // An API-key session reports `rate_limits_available: false` and emits zero
    // `_claude/rateLimit` frames (measured on the wire for R8.1). It has no plan
    // window to gain, so it must not pick up a subscription session's.
    process.env.ANTHROPIC_API_KEY = "sk-ant-whatever";
    expect(await readFreshLimits(60_000, 1_500)).toBeNull();
  });

  it("writes nothing, so it cannot publish its emptiness to anyone", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-whatever";
    await writeLimits(LIMITS, 1_000);
    expect((await fs.readdir(dir)).length).toBe(0);
  });

  it("never lets the key reach a hash", async () => {
    // The first version folded a digest of the key into the filename to keep two
    // keys apart. CodeQL flagged it (js/insufficient-password-hash) and excluding
    // the case turned out to be stronger than hashing it well: two keys cannot
    // collide in a file neither of them writes.
    process.env.ANTHROPIC_API_KEY = "sk-ant-one";
    const first = quotaCachePath();
    process.env.ANTHROPIC_API_KEY = "sk-ant-two-completely-different";
    expect(quotaCachePath()).toBe(first);
    expect(path.basename(first)).not.toContain("sk-ant");
  });
});

describe("the file is scoped to the configuration that produced the sample", () => {
  it("separates two config directories", async () => {
    process.env.ANTHROPIC_CONFIG_DIR = "/home/someone/.claude-a";
    const first = quotaCachePath();
    process.env.ANTHROPIC_CONFIG_DIR = "/home/someone/.claude-b";
    expect(quotaCachePath()).not.toBe(first);
  });

  it("lives under XDG_RUNTIME_DIR when there is one", async () => {
    expect(path.dirname(quotaCachePath())).toBe(dir);
  });
});

describe("the freshness window is narrower than the interval", () => {
  it("leaves a margin instead of sitting on the boundary", () => {
    // Equal, and whether a process re-fetches on its own tick turns on
    // sub-millisecond timing. The margin makes both cases decidable.
    expect(sharedSampleMaxAgeMs(60_000)).toBe(54_000);
    expect(sharedSampleMaxAgeMs(30_000)).toBe(27_000);
  });

  it("keeps a process's own last sample stale at its next tick", () => {
    expect(sharedSampleMaxAgeMs(60_000)).toBeLessThan(60_000);
  });
});
