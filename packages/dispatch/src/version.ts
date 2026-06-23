import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single source of truth for the package version. Read once from `package.json`
 * at module load so the MCP server handshake, CLI `--version`, and any other
 * surface can't drift from the published version. The relative `..` is stable
 * in both the dev layout (`src/version.ts` → `src/../package.json`) and the
 * built layout (`dist/version.js` → `dist/../package.json`).
 */
const FALLBACK_VERSION = "0.0.0";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : FALLBACK_VERSION;
  } catch {
    // A missing/unreadable package.json must never crash the server or CLI.
    return FALLBACK_VERSION;
  }
}

/** The package version, resolved once at module load. */
export const VERSION: string = readVersion();
