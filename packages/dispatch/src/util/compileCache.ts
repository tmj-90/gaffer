import module from "node:module";

/**
 * Turn on Node's on-disk compile cache for this process, so the next `dispatch`
 * call reuses the bytecode V8 compiled for the modules this one loads instead of
 * compiling them again. A CLI entry calls it first and then `await import()`s the
 * real program: static imports are compiled before a module's body runs, so they
 * would load uncached.
 *
 * The cache lives where Node puts it by default: `$NODE_COMPILE_CACHE` when set,
 * else `<os.tmpdir()>/node-compile-cache`, keyed by Node version and source hash so
 * a rebuild or a Node upgrade never reuses stale bytecode. `NODE_DISABLE_COMPILE_CACHE=1`
 * turns it off. On a Node without `module.enableCompileCache` (before 22.1) this is a
 * no-op, and a cache that cannot be written (read-only tmp) only costs the speedup:
 * nothing here throws.
 */
export function enableCompileCache(): void {
  const enable = (module as { enableCompileCache?: () => unknown }).enableCompileCache;
  if (typeof enable !== "function") return;
  try {
    enable();
  } catch {
    // Best effort: a cache is an optimisation, never a reason to fail a command.
  }
}
