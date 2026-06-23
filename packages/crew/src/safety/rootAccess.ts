import { isAbsolute, relative, resolve } from "node:path";

/**
 * Repo-access boundary (FG-007) — TypeScript parity for the runtime safety hook.
 *
 * `runner/safety-hook.mjs` enforces, at runtime, that an agent may only
 * WRITE inside an explicit set of write-roots and READ inside the union of
 * write-roots and read-roots (see that file's REPO-ACCESS BOUNDARY block). This
 * module mirrors that exact root logic so the Crew TS guard and the
 * runtime hook agree — a security control duplicated on purpose so neither
 * depends on the other's build, with `test/safety-hook-parity.test.ts`-style
 * pinning to stop them drifting.
 *
 * Env contract (parsed identically to the hook): write/read root lists are
 * newline- OR colon-separated absolute repo paths.
 */

/** Where a path falls relative to the configured roots. */
export type RootAccess = "write" | "read" | "outside";

export interface RootSet {
  /** Repos the agent may write to (and create branches in). */
  readonly writeRoots: readonly string[];
  /** Extra repos the agent may read (never write). */
  readonly readRoots: readonly string[];
}

/** Split a roots value on newlines or colons; resolve each to an absolute path. */
export function parseRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n:]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
}

/** True when `target` resolves at, or strictly under, `root` (guards `..` escapes). */
export function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isInsideAny(roots: readonly string[], target: string): boolean {
  return roots.some((root) => isInsideRoot(root, target));
}

/**
 * Classify an absolute path against the root set. Mirrors the hook's
 * `classifyRootAccess`: "write" inside a write-root, "read" inside a read-root
 * but not a write-root, "outside" otherwise. Read access is the UNION of write
 * and read roots — a write-root is always readable.
 */
export function classifyRootAccess(targetPath: string, roots: RootSet): RootAccess {
  const abs = resolve(targetPath);
  if (isInsideAny(roots.writeRoots, abs)) return "write";
  if (isInsideAny(roots.readRoots, abs)) return "read";
  return "outside";
}

/** Build a RootSet from the GAFFER_WRITE_ROOTS / GAFFER_READ_ROOTS env vars. */
export function rootSetFromEnv(env: NodeJS.ProcessEnv = process.env): RootSet {
  return {
    writeRoots: parseRoots(env.GAFFER_WRITE_ROOTS),
    readRoots: parseRoots(env.GAFFER_READ_ROOTS),
  };
}

/** True when any roots are explicitly configured (vs. single-repo fallback). */
export function rootsConfigured(roots: RootSet): boolean {
  return roots.writeRoots.length > 0 || roots.readRoots.length > 0;
}
