import { describe, it, expect, beforeEach, vi } from "vitest";
import { accountIdentity } from "../account-usage.js";

/**
 * Story 002, sub-task 1.5 — naming the account the quota windows belong to.
 *
 * Contract (R2.1, R2.2, R2.3, R2.4): the identity is `<subscription> · <profile>`,
 * where the subscription type comes from the structured usage report and the
 * profile is the basename of the configuration directory in use — reported as
 * `default` for the default directory rather than as the `.claude` implementation
 * detail. With no subscription type, the profile name stands alone rather than
 * the identity being omitted.
 *
 * The last test is the point of the file. The VS Code extension shows the
 * account e-mail; that would mean reading `.credentials.json`, a secret file,
 * and then carrying its contents through `_meta` over ACP and into any log that
 * records notifications. The rule is asserted by SPYING ON THE FILE READER, not
 * by reading the source: a security decision with no test is a comment, and a
 * grep for a filename cannot see an implementation that builds the path.
 */

const { fileCalls, recordCalls } = vi.hoisted(() => {
  const fileCalls: Array<{ module: string; fn: string; args: unknown[] }> = [];

  /** Wrap every function a filesystem module exports so the call — and its
   *  arguments — is recorded before the real one runs. One level of nesting is
   *  wrapped too, which covers `fs.promises.*` and the default export. */
  function recordCalls(
    moduleName: string,
    actual: Record<string, unknown>,
  ): Record<string, unknown> {
    const wrapped: Record<string, unknown> = {};
    for (const key of Object.keys(actual)) {
      const value = actual[key];
      if (typeof value === "function") {
        wrapped[key] = (...args: unknown[]) => {
          fileCalls.push({ module: moduleName, fn: key, args });
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        wrapped[key] = recordCalls(`${moduleName}.${key}`, value as Record<string, unknown>);
      } else {
        wrapped[key] = value;
      }
    }
    return wrapped;
  }

  return { fileCalls, recordCalls };
});

vi.mock("node:fs", async (importOriginal) =>
  recordCalls("node:fs", (await importOriginal()) as Record<string, unknown>),
);
vi.mock("fs", async (importOriginal) =>
  recordCalls("fs", (await importOriginal()) as Record<string, unknown>),
);
vi.mock("node:fs/promises", async (importOriginal) =>
  recordCalls("node:fs/promises", (await importOriginal()) as Record<string, unknown>),
);
vi.mock("fs/promises", async (importOriginal) =>
  recordCalls("fs/promises", (await importOriginal()) as Record<string, unknown>),
);

const DEFAULT_CONFIG_DIR = "/home/tester/.claude";
const WORK_CONFIG_DIR = "/home/tester/claude-profiles/work";

describe("the account identity composes a subscription and a profile", () => {
  it("joins the subscription type and the profile name", () => {
    expect(accountIdentity("pro", WORK_CONFIG_DIR)).toBe("pro · work");
    expect(accountIdentity("max", WORK_CONFIG_DIR)).toBe("max · work");
  });

  it("reports the default configuration directory as `default` (R2.2)", () => {
    // `.claude` is where the directory lives, not what the profile is called.
    expect(accountIdentity("max", DEFAULT_CONFIG_DIR)).toBe("max · default");
  });

  it("reports the profile alone when no subscription type is available (R2.4)", () => {
    // API-key, Bedrock and Vertex sessions have no subscription type. The
    // identity degrades to the profile rather than disappearing.
    expect(accountIdentity(null, WORK_CONFIG_DIR)).toBe("work");
    expect(accountIdentity(undefined, DEFAULT_CONFIG_DIR)).toBe("default");
  });

  it("keeps two different profiles apart", () => {
    // Hostile half: an identity that cannot distinguish the account it names is
    // worse than none, because the panel would label one account's bars with
    // another's name.
    expect(accountIdentity("max", DEFAULT_CONFIG_DIR)).not.toBe(
      accountIdentity("max", WORK_CONFIG_DIR),
    );
  });
});

describe("the identity path opens no credential file (R2.3)", () => {
  beforeEach(() => {
    fileCalls.length = 0;
  });

  it("never reaches for `.credentials.json`, and reads no file at all", () => {
    const identities = [
      accountIdentity("max", DEFAULT_CONFIG_DIR),
      accountIdentity("pro", WORK_CONFIG_DIR),
      accountIdentity(null, WORK_CONFIG_DIR),
    ];

    // The identity really was produced — an implementation that returned
    // nothing would trivially satisfy every assertion below.
    for (const identity of identities) {
      expect(identity.length).toBeGreaterThan(0);
      // No e-mail address: the credential file's payload has exactly one
      // recognisable shape, and this is it.
      expect(identity).not.toContain("@");
    }

    const credentialReads = fileCalls.filter((call) =>
      call.args.some((arg) => typeof arg === "string" && arg.endsWith(".credentials.json")),
    );
    expect(credentialReads).toEqual([]);

    // Stronger than the rule and deliberately so: the identity is a value
    // already in hand plus a string operation, so the correct number of
    // filesystem calls is zero. This still fails for an implementation that
    // reached for the credential file under any other name or path.
    expect(fileCalls.map((call) => `${call.module}.${call.fn}`)).toEqual([]);
  });
});
