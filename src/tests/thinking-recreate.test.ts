import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";

const mockQuery = vi.hoisted(() =>
  vi.fn(() => ({
    initializationResult: vi.fn().mockResolvedValue({
      models: [
        { value: "id", displayName: "name", description: "description", supportsAutoMode: true },
      ],
    }),
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    supportedCommands: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    getContextUsage: vi.fn().mockResolvedValue({ totalTokens: 0, rawMaxTokens: 200000 }),
    [Symbol.asyncIterator]: async function* () {},
  })),
);

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  query: mockQuery,
}));

// A fresh thread's first turn used to carry "the updated Thinking setting could
// not be applied": Zed applies default_config_options.thinking before the first
// prompt, the lazy recreate then RESUMED a session that had no transcript yet,
// and the CLI answered "No conversation found with session ID".
describe("Thinking recreate of a session with no transcript yet", () => {
  let configDir: string;
  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "thinking-recreate-"));
  });
  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function freshSession() {
    const agent = new ClaudeAcpAgent({ sessionUpdate: async () => {} } as unknown as AcpClient, {
      log: () => {},
      error: () => {},
    });
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const session = (agent as any).sessions[sessionId];
    // The config dir THIS query runs with is where its transcript would be.
    session.queryOptions.env = { ...session.queryOptions.env, CLAUDE_CONFIG_DIR: configDir };
    return { agent, sessionId, session };
  }
  const lastOptions = () =>
    (mockQuery.mock.calls.at(-1) as unknown as [{ options: Record<string, unknown> }])[0].options;

  it("starts the replacement as a new session under the same id", async () => {
    const { agent, sessionId, session } = await freshSession();

    await (agent as any).recreateSessionQuery(sessionId, session);

    expect(lastOptions().resume).toBeUndefined();
    expect(lastOptions().sessionId).toBe(sessionId);
  });

  it("still resumes once the session has a transcript", async () => {
    const { agent, sessionId, session } = await freshSession();
    const project = path.join(configDir, "projects", "-some-project");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, `${sessionId}.jsonl`), "{}\n");

    await (agent as any).recreateSessionQuery(sessionId, session);

    expect(lastOptions().resume).toBe(sessionId);
    expect(lastOptions().sessionId).toBeUndefined();
  });
});
