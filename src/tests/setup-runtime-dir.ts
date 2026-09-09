/**
 * Point every test at a throwaway `XDG_RUNTIME_DIR`.
 *
 * `quota-cache.ts` shares one sample per machine through a file there, which is
 * the right home in production and a trap in a test run: without this, any test
 * that ends a turn writes into the developer's LIVE runtime directory, beside
 * the samples their running adapters are using -- and reads whatever those
 * adapters last wrote. Two things went wrong before this existed, and both were
 * silent: the suite littered `/run/user/<uid>` with dozens of files, and cases
 * that never mention the cache became order- and machine-dependent, failing in
 * the full run while passing alone.
 *
 * Per worker, not per file: vitest runs files in separate processes, so one
 * directory per process keeps parallel files from sharing a sample while still
 * letting the cases inside a file exercise sharing on purpose.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "acp-test-runtime-"));
process.env.XDG_RUNTIME_DIR = dir;

process.on("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});
