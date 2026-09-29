import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  parseTranscript,
  precompactMessages,
  withPrecompactHistory,
} from "../compacted-history.js";

const SID = "session-1";

type Rec = Record<string, unknown>;
const user = (uuid: string, parentUuid: string | null, text: string, extra: Rec = {}): Rec => ({
  type: "user",
  uuid,
  parentUuid,
  message: { role: "user", content: text },
  ...extra,
});
const assistant = (uuid: string, parentUuid: string | null, text: string): Rec => ({
  type: "assistant",
  uuid,
  parentUuid,
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const boundary = (uuid: string, logicalParentUuid: string | null): Rec => ({
  type: "system",
  subtype: "compact_boundary",
  uuid,
  parentUuid: null,
  logicalParentUuid,
});
const summary = (uuid: string, parentUuid: string): Rec =>
  user(uuid, parentUuid, "This session is being continued from a previous conversation...", {
    isCompactSummary: true,
  });

const jsonl = (records: Rec[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const texts = (messages: SessionMessage[]) =>
  messages.map((m) => {
    const content = (m.message as { content: unknown }).content;
    return typeof content === "string" ? content : (content as { text: string }[])[0].text;
  });

describe("precompactMessages", () => {
  it("walks back through logicalParentUuid", () => {
    const records = parseTranscript(
      jsonl([
        user("u1", null, "first prompt"),
        assistant("a1", "u1", "first answer"),
        user("u2", "a1", "second prompt"),
        boundary("b1", "u2"),
        summary("s1", "b1"),
      ]),
    );
    expect(texts(precompactMessages(records, SID))).toEqual([
      "first prompt",
      "first answer",
      "second prompt",
    ]);
  });

  it("falls back to position when the logical parent is not in the file", () => {
    // A manual /compact can name a parent the file never received (measured on a
    // real transcript): continue from the last main-chain record before it.
    const records = parseTranscript(
      jsonl([
        user("u1", null, "first prompt"),
        assistant("a1", "u1", "first answer"),
        boundary("b1", "missing-uuid"),
        summary("s1", "b1"),
      ]),
    );
    expect(texts(precompactMessages(records, SID))).toEqual(["first prompt", "first answer"]);
  });

  it("crosses every earlier compaction, not only the last", () => {
    const records = parseTranscript(
      jsonl([
        user("u1", null, "oldest"),
        boundary("b1", "u1"),
        summary("s1", "b1"),
        user("u2", "s1", "middle"),
        boundary("b2", "u2"),
        summary("s2", "b2"),
      ]),
    );
    expect(texts(precompactMessages(records, SID))).toEqual([
      "oldest",
      "This session is being continued from a previous conversation...",
      "middle",
    ]);
  });

  it("keeps getSessionMessages' filters: no isMeta, no sidechain", () => {
    const records = parseTranscript(
      jsonl([
        user("u1", null, "prompt"),
        user("m1", "u1", "meta", { isMeta: true }),
        assistant("a1", "m1", "answer"),
        { ...assistant("x1", "a1", "subagent"), isSidechain: true },
        boundary("b1", "a1"),
      ]),
    );
    const messages = precompactMessages(records, SID);
    expect(texts(messages)).toEqual(["prompt", "answer"]);
    expect(messages[0]).toMatchObject({
      session_id: SID,
      parent_tool_use_id: null,
      is_meta: false,
    });
  });

  it("returns nothing for a transcript that was never compacted", () => {
    const records = parseTranscript(jsonl([user("u1", null, "p"), assistant("a1", "u1", "a")]));
    expect(precompactMessages(records, SID)).toEqual([]);
  });
});

describe("withPrecompactHistory", () => {
  let configDir: string;
  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "compacted-history-"));
  });
  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  const writeTranscript = async (records: Rec[]) => {
    const dir = path.join(configDir, "projects", "-some-project");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${SID}.jsonl`), jsonl(records));
  };
  const sdkMessage = (record: Rec): SessionMessage =>
    ({
      type: record.type,
      uuid: record.uuid,
      session_id: SID,
      message: record.message,
      parent_tool_use_id: null,
      parent_agent_id: null,
      ...(record.isCompactSummary ? { isCompactSummary: true } : {}),
    }) as SessionMessage;

  it("puts the pre-compaction history in front, once per uuid", async () => {
    const preserved = assistant("a1", "u1", "preserved answer");
    const s1 = summary("s1", "b1");
    await writeTranscript([
      user("u1", null, "first prompt"),
      preserved,
      boundary("b1", "a1"),
      s1,
      user("u2", "a1", "after compaction"),
    ]);
    // A preserved message is written ONCE, before the boundary (measured on a real
    // transcript); getSessionMessages relinks it after the summary. So it arrives
    // in both halves under one uuid, and must be shown once.
    const sdk = [
      sdkMessage(s1),
      sdkMessage(preserved),
      sdkMessage(user("u2", "a1", "after compaction")),
    ];

    const result = await withPrecompactHistory(SID, sdk, configDir);

    expect(texts(result)).toEqual([
      "first prompt",
      "This session is being continued from a previous conversation...",
      "preserved answer",
      "after compaction",
    ]);
  });

  it("returns the SDK's list untouched when it does not start at a compaction", async () => {
    // No transcript written: an uncompacted session must not need one.
    const sdk = [sdkMessage(user("u1", null, "p"))];
    expect(await withPrecompactHistory(SID, sdk, configDir)).toBe(sdk);
  });

  it("returns the SDK's list untouched when the transcript cannot be found", async () => {
    const sdk = [sdkMessage(summary("s1", "b1"))];
    expect(await withPrecompactHistory(SID, sdk, configDir)).toBe(sdk);
  });
});
