import { describe, expect, it, vi } from "vitest";
import { AcpClient, ClaudeAcpAgent, computeSessionFingerprint } from "../acp-agent.js";

// The additionalDirectories half of upstream #1097: the SDK reads workspace roots
// only when the Query process starts, so a warm session/load or session/resume
// that changed them must recreate the process instead of reusing the old one.
describe("session fingerprint — additional directories", () => {
  const base = { cwd: "/repo", mcpServers: [] };

  it("changes when the additional directories change", () => {
    expect(computeSessionFingerprint({ ...base, additionalDirectories: ["/a"] })).not.toBe(
      computeSessionFingerprint({ ...base, additionalDirectories: ["/a", "/b"] }),
    );
  });

  it("ignores order, duplicates, and absent versus empty", () => {
    expect(computeSessionFingerprint({ ...base, additionalDirectories: ["/b", "/a", "/a"] })).toBe(
      computeSessionFingerprint({ ...base, additionalDirectories: ["/a", "/b"] }),
    );
    expect(computeSessionFingerprint(base)).toBe(
      computeSessionFingerprint({ ...base, additionalDirectories: [] }),
    );
  });

  it("falls back to _meta.additionalRoots, as createSession does", () => {
    expect(computeSessionFingerprint({ ...base, _meta: { additionalRoots: ["/a"] } })).toBe(
      computeSessionFingerprint({ ...base, additionalDirectories: ["/a"] }),
    );
  });

  function agentWithWarmSession(
    fingerprintParams: Parameters<typeof computeSessionFingerprint>[0],
  ) {
    const agent = new ClaudeAcpAgent({} as unknown as AcpClient, {
      log: () => {},
      error: () => {},
    });
    const modes = { currentModeId: "default", availableModes: [] };
    (agent as any).sessions["s1"] = {
      sessionFingerprint: computeSessionFingerprint(fingerprintParams),
      modes,
      configOptions: [],
    };
    const teardown = vi.fn(async () => {});
    const create = vi.fn(async () => ({ sessionId: "s1", modes, configOptions: [] }));
    (agent as any).teardownSession = teardown;
    (agent as any).createSession = create;
    return { agent, teardown, create };
  }

  it("recreates a warm session whose additional directories changed", async () => {
    const { agent, teardown, create } = agentWithWarmSession({
      ...base,
      additionalDirectories: ["/a"],
    });

    await (agent as any).getOrCreateSession({
      sessionId: "s1",
      ...base,
      additionalDirectories: ["/a", "/b"],
    });

    expect(teardown).toHaveBeenCalledWith("s1");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ additionalDirectories: ["/a", "/b"] }),
      { resume: "s1" },
    );
  });

  it("reuses a warm session whose additional directories did not change", async () => {
    const { agent, teardown, create } = agentWithWarmSession({
      ...base,
      additionalDirectories: ["/a", "/b"],
    });

    await (agent as any).getOrCreateSession({
      sessionId: "s1",
      ...base,
      additionalDirectories: ["/b", "/a"],
    });

    expect(teardown).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
