import { access, readdir } from "node:fs/promises";
import * as path from "node:path";

/** `<configDir>/projects/<any project>/<sessionId>.jsonl` -- where the SDK looks
 *  when `getSessionMessages` is called without a directory. */
export async function findTranscript(
  configDir: string,
  sessionId: string,
): Promise<string | undefined> {
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
