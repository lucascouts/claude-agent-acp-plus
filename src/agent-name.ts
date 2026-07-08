// Single import point for the adapter's announced agent identity (R2.1, R2.2).
// This file must stay top-level in src/: it compiles to dist/agent-name.js,
// where the `../package.json` relative import still resolves. A subdirectory
// placement would compile to dist/<subdir>/ and break that path.
import packageJson from "../package.json" with { type: "json" };

// Strips a leading npm scope (`@scope/`) from a package name; unscoped names
// pass through unchanged. Anchored replace (not split("/")) so an unscoped
// name is never mangled.
export function agentNameFromPackageName(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}

// The agent name this adapter announces over ACP, derived from its own
// package.json `name` — e.g. "@lucascouts/claude-agent-acp-fork" →
// "claude-agent-acp-fork". Consumed by the ACP initialize wiring.
export const agentName = agentNameFromPackageName(packageJson.name);
