import module from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Where the compile cache lives: `$NODE_COMPILE_CACHE` when the operator sets it,
 * else the package's own `node_modules/.cache/node-compile-cache`.
 *
 * Not Node's default (`<os.tmpdir()>/node-compile-cache`): Node runs the bytecode it
 * finds in the cache once the source hash recorded next to it matches, so whoever can
 * write the cache directory chooses the code a later process runs. A strict-mode
 * agent may write the temp dirs (lib/sandbox.sh grants $TMPDIR and /tmp), and the
 * runner's own `wg` calls carry the runner's whole environment (review finding
 * testspeed-review/R-1). Next to the package, the cache is exactly as writable as the
 * `dist/` it caches.
 */
export function compileCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = env["NODE_COMPILE_CACHE"]?.trim();
  if (set) return set;
  // dist/util/compileCache.js (and src/util/compileCache.ts) -> the package root.
  return fileURLToPath(new URL("../../node_modules/.cache/node-compile-cache", import.meta.url));
}

/**
 * Turn on Node's on-disk compile cache for this process, so the next `dispatch`
 * call reuses the bytecode V8 compiled for the modules this one loads instead of
 * compiling them again. A CLI entry calls it first and then `await import()`s the
 * real program: static imports are compiled before a module's body runs, so they
 * would load uncached.
 *
 * The cache lives in {@link compileCacheDir}, keyed by Node version and each file's
 * source hash, so a rebuild or a Node upgrade never reuses stale bytecode.
 * `NODE_DISABLE_COMPILE_CACHE=1` turns it off. On a Node without
 * `module.enableCompileCache` (before 22.1) this is a no-op, and a cache that cannot
 * be written (a read-only install, another user's checkout) only costs the speedup:
 * nothing here throws.
 */
export function enableCompileCache(): void {
  const enable = (module as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache;
  if (typeof enable !== "function") return;
  try {
    enable(compileCacheDir());
  } catch {
    // Best effort: a cache is an optimisation, never a reason to fail a command.
  }
}
