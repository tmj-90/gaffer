import { spawnSync } from "node:child_process";

/**
 * CODE INDEX reader: the memory CLI's `index neighbours --json` (files -> symbols ->
 * imports -> tests, built by the runner at onboard and after each merge). Dispatch reads
 * it the way it reads every Memory surface: by spawning the configured CLI with the DB in
 * the child env (`MEMORY_CLI_BIN`, `MEMORY_DB`), never by opening Memory's database. No
 * model is involved; every answer is "by import text (index)" and a lower bound.
 *
 * FAIL-SOFT: not configured, a spawn error, a non-zero exit or unparsable output is an
 * `{ ok: false, reason }` answer, which the Behavioural surface says as "not analysed".
 */

export const MEMORY_CLI_BIN_ENV = "MEMORY_CLI_BIN";
export const MEMORY_DB_ENV = "MEMORY_DB";

/** A local read of a small SQLite index: a few hundred ms at most. */
const TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 2_000_000;
/** Fresh answers are cached this long per (repo, base commit, query): Review re-reads the diff. */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 64;

export interface CodeIndexRef {
  path: string;
  via: "name" | "module" | "barrel";
  through: string | null;
  line: number;
  tested?: boolean;
}

export interface CodeIndexTest {
  path: string;
  via: "import" | "name" | "barrel";
  through: string | null;
}

export interface CodeIndexItem {
  query: string;
  path: string | null;
  symbol: string | null;
  exportedAs: string | null;
  note: string | null;
  callers: CodeIndexRef[];
  callersTotal: number;
  callersTested: number;
  tests: CodeIndexTest[];
  testsTotal: number;
  moduleTestsTotal: number;
}

export interface CodeIndexResult {
  status: "missing" | "fresh" | "stale" | "unknown";
  method: string;
  /** capsHit (absent from an older memory): the build stopped at a cap, so counts are partial. */
  build: { commit: string | null; builtAt: string; files: number; capsHit?: string[] } | null;
  against: string | null;
  items: CodeIndexItem[];
}

export interface CodeIndexQuery {
  /** The repo's local checkout (its canonical identity is derived from it). */
  localPath: string;
  paths: readonly string[];
  /** `path#name`. */
  symbols: readonly string[];
  /** The commit the index should describe (the base branch tip): fresh vs stale. */
  commit: string | null;
  perItem: number;
}

export type CodeIndexAnswer = { ok: true; result: CodeIndexResult } | { ok: false; reason: string };

export type CodeIndexReader = (q: CodeIndexQuery) => CodeIndexAnswer;

function isResult(v: unknown): v is CodeIndexResult {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o["status"] === "string" && Array.isArray(o["items"]);
}

/** A reader over the configured memory CLI, or null when Memory is not configured. */
export function resolveCodeIndexReader(
  env: NodeJS.ProcessEnv = process.env,
): CodeIndexReader | null {
  const bin = (env[MEMORY_CLI_BIN_ENV] ?? "").trim();
  const db = (env[MEMORY_DB_ENV] ?? "").trim();
  if (bin === "" || db === "") return null;
  const cache = new Map<string, { at: number; answer: CodeIndexAnswer }>();
  return (q) => {
    const key = JSON.stringify([q.localPath, q.commit, q.paths, q.symbols, q.perItem]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.answer;
    // `--flag=value`: a value is never read as a flag, whatever the path is called.
    const args = [
      bin,
      "index",
      "neighbours",
      `--repo-root=${q.localPath}`,
      `--per-item=${q.perItem}`,
      ...q.paths.map((p) => `--paths=${p}`),
      ...q.symbols.map((s) => `--symbols=${s}`),
      ...(q.commit ? [`--commit=${q.commit}`] : []),
      "--json",
    ];
    const { DISPATCH_API_TOKEN: _omit, ...rest } = env;
    void _omit;
    let answer: CodeIndexAnswer;
    try {
      const r = spawnSync(process.execPath, args, {
        encoding: "utf8",
        env: { ...rest, [MEMORY_DB_ENV]: db, NO_COLOR: "1", MEMORY_NO_COLOR: "1" },
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      if (r.error)
        answer = { ok: false, reason: `the memory CLI did not run (${r.error.message})` };
      else if (r.status !== 0)
        answer = {
          ok: false,
          reason: `the memory CLI exited ${r.status ?? "?"}${(r.stderr ?? "").trim() ? `: ${(r.stderr ?? "").trim().split("\n")[0]}` : ""}`,
        };
      else {
        const parsed: unknown = JSON.parse(r.stdout ?? "");
        answer = isResult(parsed)
          ? { ok: true, result: parsed }
          : { ok: false, reason: "the memory CLI answered in a shape this version does not read" };
      }
    } catch (e) {
      answer = {
        ok: false,
        reason: `the memory CLI answer could not be read (${e instanceof Error ? e.message : String(e)})`,
      };
    }
    // Only a fresh answer is kept: it describes the base commit in the key, so it cannot
    // change; a missing or stale index may be (re)built any moment and must be re-read.
    if (answer.ok && answer.result.status === "fresh") {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: Date.now(), answer });
    }
    return answer;
  };
}
