import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Resolve an executable to an absolute path WITHOUT spawning a shell. Checks, in
 * order: a repo-local `node_modules/.bin/<name>` (so a tool installed as a repo
 * dev-dependency is preferred), then each `PATH` entry. Returns the first hit, or
 * `undefined` when the tool is not installed.
 *
 * No shell is involved at any point: we stat candidate paths directly, so a tool
 * name is never interpolated into a command line. The absolute path we return is
 * later passed to `runArgs` as argv[0] (still no shell).
 */
export function resolveBinary(
  name: string,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // A name with a path separator is taken as-is (caller already resolved it).
  if (name.includes("/") || name.includes("\\")) {
    return isExecutable(name) ? name : undefined;
  }

  const localBin = join(root, "node_modules", ".bin", name);
  if (isExecutable(localBin)) return localBin;

  const pathEntries = (env.PATH ?? "").split(delimiter).filter((p) => p.length > 0);
  // On Windows an executable may carry an extension; PATHEXT lists them.
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter((e) => e.length > 0)
      : [""];

  for (const dir of pathEntries) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** True when `path` exists and is executable (or simply readable on Windows). */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
