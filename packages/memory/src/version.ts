/**
 * Single source of truth for the package version.
 *
 * Read from `package.json` at runtime rather than hardcoded in each
 * call site (doctor, `--version`, the MCP server handshake) — those
 * drifted apart before, and a stale version string is a quietly
 * misleading bug. `package.json` is one directory up from this module
 * in both the dev (`src/version.ts`) and built (`dist/version.js`)
 * layouts, so the relative resolve is stable across both.
 *
 * Falls back to a constant if the file can't be read (e.g. an unusual
 * bundling): a missing version must never crash the CLI or the server.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FALLBACK_VERSION = "0.0.0";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/** The package version, resolved once at module load. */
export const VERSION: string = readVersion();
