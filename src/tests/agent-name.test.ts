import { describe, it, expect } from "vitest";
import { agentNameFromPackageName } from "../agent-name.js";
import packageJson from "../../package.json" with { type: "json" };

// The ACP agent name announced to clients (e.g. Zed) must reflect the real
// package identity so fork and plus builds are distinguishable from upstream
// `claude-code-acp` while `src/` stays byte-identical across both repos.
// Contract (R2.1, R2.2): the announced name equals the package.json `name`
// with any leading npm scope (`@scope/`) removed; an unscoped name passes
// through unchanged.
describe("agentNameFromPackageName", () => {
  it("strips a leading npm scope from a scoped package name", () => {
    expect(agentNameFromPackageName("@lucascouts/claude-agent-acp-plus")).toBe(
      "claude-agent-acp-plus",
    );
  });

  it("returns an unscoped package name unchanged", () => {
    expect(agentNameFromPackageName("claude-agent-acp")).toBe("claude-agent-acp");
  });

  it("derives this adapter's announced name from its own package.json name", () => {
    // Repo-agnostic on purpose: this file is copied verbatim into the plus
    // repo, where package.json `name` differs ("@lucascouts/claude-agent-acp-plus"
    // vs "@lucascouts/claude-agent-acp-fork"). Assert structural properties of
    // the derived own-name instead of a repo-specific literal.
    const derived = agentNameFromPackageName(packageJson.name);
    expect(derived).not.toBe("");
    expect(derived).not.toContain("@");
    expect(derived).not.toContain("/");
    // The derived name is the package name minus any leading scope, so the
    // full package name must end with it.
    expect(packageJson.name.endsWith(derived)).toBe(true);
  });
});
