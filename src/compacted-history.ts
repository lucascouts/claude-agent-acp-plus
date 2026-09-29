import { access, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The history a compaction hid from `getSessionMessages`, put back in front of it.
 *
 * `getSessionMessages` walks `parentUuid` back from the newest record, and a
 * `compact_boundary` has `parentUuid: null`, so the walk ends there: a reopened
 * compacted thread replays only what came after the compaction summary. Measured
 * 2026-09-29 on this machine's two compacted transcripts -- 35 prompts in the
 * file, 12 replayed; 3 in the file, 0 replayed. The boundary does remember what
 * it followed (`logicalParentUuid`), and the SDK never reads it.
 *
 * This reads the transcript itself and walks back across the boundary: through
 * `logicalParentUuid` when that record is in the file, else from the last
 * main-chain record written before the boundary (a manual `/compact` can name a
 * parent the file never received), and across every earlier boundary the same
 * way. What it returns has the shape and the filters `getSessionMessages` uses --
 * user and assistant records only, never `isMeta`, never a sidechain -- so the
 * replay loop cannot tell the two halves apart.
 *
 * It only reads anything when the SDK's first message IS a compaction summary;
 * an uncompacted session costs nothing. It never writes.
 */
export async function withPrecompactHistory(
  sessionId: string,
  messages: SessionMessage[],
  configDir: string,
): Promise<SessionMessage[]> {
  if (!startsWithCompactSummary(messages)) return messages;
  const file = await findTranscript(configDir, sessionId);
  if (!file) return messages;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return messages;
  }
  const earlier = precompactMessages(parseTranscript(text), sessionId);
  if (earlier.length === 0) return messages;
  const seen = new Set(messages.map((message) => message.uuid));
  // Messages a compaction preserved keep their uuid on both sides of the
  // boundary; the copy after it is the one the SDK already returns.
  return [...earlier.filter((message) => !seen.has(message.uuid)), ...messages];
}

type TranscriptRecord = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: unknown;
  timestamp?: string;
  line: number;
};

export function parseTranscript(text: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  const lines = text.split("\n");
  for (let line = 0; line < lines.length; line++) {
    if (!lines[line].trim()) continue;
    try {
      records.push({ ...(JSON.parse(lines[line]) as object), line });
    } catch {
      // A torn last line from a crashed writer: skip it, as the SDK does.
    }
  }
  return records;
}

function isBoundary(record: TranscriptRecord): boolean {
  return record.type === "system" && record.subtype === "compact_boundary";
}

function isMainChain(record: TranscriptRecord): boolean {
  return typeof record.uuid === "string" && record.isSidechain !== true;
}

/** The main-chain history written before the LAST compaction boundary, oldest
 *  first, in `getSessionMessages`'s shape. Empty when the file has no boundary. */
export function precompactMessages(
  records: TranscriptRecord[],
  sessionId: string,
): SessionMessage[] {
  const byUuid = new Map<string, TranscriptRecord>();
  for (const record of records) if (record.uuid) byUuid.set(record.uuid, record);

  const boundaries = records.filter(isBoundary);
  const last = boundaries[boundaries.length - 1];
  if (!last) return [];

  // Where a boundary's history continues: its logical parent when the file has
  // it, else the last main-chain record written before the boundary.
  const continuation = (boundary: TranscriptRecord): TranscriptRecord | undefined => {
    const logical = boundary.logicalParentUuid ? byUuid.get(boundary.logicalParentUuid) : undefined;
    if (logical) return logical;
    for (let i = records.indexOf(boundary) - 1; i >= 0; i--) {
      if (isMainChain(records[i]) && !isBoundary(records[i])) return records[i];
    }
    return undefined;
  };

  const chain: TranscriptRecord[] = [];
  const visited = new Set<string>();
  let cursor = continuation(last);
  while (cursor && cursor.uuid && !visited.has(cursor.uuid)) {
    visited.add(cursor.uuid);
    if (isBoundary(cursor)) {
      cursor = continuation(cursor);
      continue;
    }
    chain.push(cursor);
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
  }

  return chain
    .reverse()
    .filter(
      (record) =>
        (record.type === "user" || record.type === "assistant") &&
        record.isMeta !== true &&
        record.isSidechain !== true,
    )
    .map(
      (record) =>
        ({
          type: record.type as "user" | "assistant",
          uuid: record.uuid as string,
          session_id: sessionId,
          message: record.message,
          parent_tool_use_id: null,
          parent_agent_id: null,
          ...(record.isCompactSummary ? { isCompactSummary: true } : {}),
          is_meta: false,
          ...(record.timestamp ? { timestamp: record.timestamp } : {}),
        }) as SessionMessage,
    );
}

function startsWithCompactSummary(messages: SessionMessage[]): boolean {
  const first = messages[0] as (SessionMessage & { isCompactSummary?: boolean }) | undefined;
  return first?.isCompactSummary === true;
}

/** `<configDir>/projects/<any project>/<sessionId>.jsonl` -- where the SDK looks
 *  when `getSessionMessages` is called without a directory. */
async function findTranscript(configDir: string, sessionId: string): Promise<string | undefined> {
  const projects = path.join(configDir, "projects");
  let entries: string[];
  try {
    entries = await readdir(projects);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const candidate = path.join(projects, entry, `${sessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not in this project
    }
  }
  return undefined;
}
