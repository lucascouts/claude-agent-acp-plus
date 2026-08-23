import { describe, it, expect, vi, afterEach } from "vitest";
import { resolvePermissionMode, type Logger } from "../acp-agent.js";

function mockLogger() {
  const error = vi.fn<(...args: any[]) => void>();
  const log = vi.fn<(...args: any[]) => void>();
  const logger: Logger = { log, error };
  return { logger, error, log };
}

// `bypassPermissions` is the one mode whose resolution depends on the process it
// resolves in: `ALLOW_BYPASS` is a module-level constant computed at import time
// from the effective uid and `IS_SANDBOX`. Asserting on it against whichever uid
// happens to be running makes the test agree with its environment rather than
// with the code — it passes as a normal user and fails as root, and a
// container-based runner is root. Both sides are therefore loaded explicitly,
// with a fresh module registry so the constant is recomputed under each.
let restoreUid: (() => void) | undefined;

async function loadResolver(bypassAllowed: boolean) {
  vi.resetModules();

  if (bypassAllowed) {
    // A truthy IS_SANDBOX satisfies ALLOW_BYPASS whatever the uid, so this arm
    // holds for a root runner and an unprivileged one alike.
    vi.stubEnv("IS_SANDBOX", "1");
  } else {
    vi.stubEnv("IS_SANDBOX", undefined);
    // Both accessors are replaced: the constant reads `geteuid` first and falls
    // back to `getuid`, so leaving either real would let the host's uid decide.
    const proc = process as { geteuid?: () => number; getuid?: () => number };
    const originalGeteuid = proc.geteuid;
    const originalGetuid = proc.getuid;
    proc.geteuid = () => 0;
    proc.getuid = () => 0;
    restoreUid = () => {
      proc.geteuid = originalGeteuid;
      proc.getuid = originalGetuid;
    };
  }

  return (await import("../acp-agent.js")).resolvePermissionMode;
}

afterEach(() => {
  restoreUid?.();
  restoreUid = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("resolvePermissionMode", () => {
  it("returns 'default' when no mode is provided", () => {
    expect(resolvePermissionMode()).toBe("default");
    expect(resolvePermissionMode(undefined)).toBe("default");
  });

  it("resolves exact canonical modes", () => {
    expect(resolvePermissionMode("default")).toBe("default");
    expect(resolvePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(resolvePermissionMode("dontAsk")).toBe("dontAsk");
    expect(resolvePermissionMode("plan")).toBe("plan");
  });

  it("resolves case-insensitive aliases", () => {
    expect(resolvePermissionMode("DontAsk")).toBe("dontAsk");
    expect(resolvePermissionMode("DONTASK")).toBe("dontAsk");
    expect(resolvePermissionMode("AcceptEdits")).toBe("acceptEdits");
  });

  it("resolves 'manual' as an alias for 'default'", () => {
    const { logger, error } = mockLogger();
    expect(resolvePermissionMode("manual", logger)).toBe("default");
    expect(resolvePermissionMode("Manual", logger)).toBe("default");
    expect(error).not.toHaveBeenCalled();
  });

  it("trims whitespace", () => {
    expect(resolvePermissionMode("  dontAsk  ")).toBe("dontAsk");
  });

  it("falls back to 'default' and logs on non-string values", () => {
    for (const value of [123, true, {}]) {
      const { logger, error } = mockLogger();
      expect(resolvePermissionMode(value, logger)).toBe("default");
      expect(error).toHaveBeenCalledWith(expect.stringContaining("expected a string"));
    }
  });

  it("falls back to 'default' and logs on empty string", () => {
    for (const value of ["", "  "]) {
      const { logger, error } = mockLogger();
      expect(resolvePermissionMode(value, logger)).toBe("default");
      expect(error).toHaveBeenCalledWith(expect.stringContaining("expected a non-empty string"));
    }
  });

  it("falls back to 'default' and logs on unknown mode", () => {
    const { logger, error } = mockLogger();
    expect(resolvePermissionMode("yolo", logger)).toBe("default");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("yolo"));
  });

  describe("bypassPermissions is gated on whether this process may bypass", () => {
    it("resolves the canonical mode and its alias when bypass is allowed", async () => {
      const resolve = await loadResolver(true);
      const { logger, error } = mockLogger();
      expect(resolve("bypassPermissions", logger)).toBe("bypassPermissions");
      expect(resolve("bypass", logger)).toBe("bypassPermissions");
      expect(error).not.toHaveBeenCalled();
    });

    it("falls back to 'default' and logs when running as root without IS_SANDBOX", async () => {
      const resolve = await loadResolver(false);
      const { logger, error } = mockLogger();
      expect(resolve("bypassPermissions", logger)).toBe("default");
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("not available when running as root"),
      );
    });
  });
});
