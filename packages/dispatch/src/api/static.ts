import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { errorBody, sendJson } from "./http.js";

/**
 * Static SPA / bundled-asset serving + the run-log tail reader. Extracted from
 * server.ts unchanged (a pure move).
 */

/** Directory holding the bundled SPA (index.html, app.js, styles.css). */
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");

/**
 * Static GET routes for the human SPA, mapping URL path → file + content-type.
 * `/` serves the SPA shell. These are the ONLY non-API GET paths the server
 * answers; every other unknown path still falls through to a JSON 404 so the
 * SPA fallback never swallows a genuine API 404 (e.g. GET /tickets/missing).
 */
const STATIC_ROUTES: ReadonlyMap<string, { file: string; type: string }> = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/gaffer-logo.svg", { file: "gaffer-logo.svg", type: "image/svg+xml" }],
  ["/gaffer-icon.svg", { file: "gaffer-icon.svg", type: "image/svg+xml" }],
  ["/gaffer-favicon.svg", { file: "gaffer-favicon.svg", type: "image/svg+xml" }],
]);

/** Bundled media served under /assets/ (hero backgrounds, textures). */
const ASSETS_DIR = join(WEB_DIR, "assets");
const ASSET_MIME: ReadonlyMap<string, string> = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);

/** Serve a known static asset. Returns true if the path was handled. */
export function serveStatic(pathname: string, res: ServerResponse): boolean {
  const match = STATIC_ROUTES.get(pathname);
  if (match) {
    try {
      const body = readFileSync(join(WEB_DIR, match.file));
      res.writeHead(200, {
        "content-type": match.type,
        "content-length": body.length,
        // Dev dashboard: never serve a stale SPA — assets change on every build.
        "cache-control": "no-store, must-revalidate",
      });
      res.end(body);
    } catch {
      sendJson(res, 500, errorBody("INTERNAL_ERROR", `Static asset missing: ${match.file}`));
    }
    return true;
  }
  // Media under /assets/ — image extensions only, and the resolved path MUST stay
  // inside WEB_DIR/assets (blocks ../ traversal). Anything else falls through to
  // the JSON 404 so a genuine API 404 is never swallowed.
  if (pathname.startsWith("/assets/")) {
    const type = ASSET_MIME.get(extname(pathname).toLowerCase());
    if (!type) return false;
    const full = resolve(ASSETS_DIR, "." + pathname.slice("/assets".length));
    if (full !== ASSETS_DIR && !full.startsWith(ASSETS_DIR + sep)) return false;
    try {
      const body = readFileSync(full);
      res.writeHead(200, {
        "content-type": type,
        "content-length": body.length,
        "cache-control": "public, max-age=3600",
      });
      res.end(body);
    } catch {
      return false;
    }
    return true;
  }
  return false;
}

/** Cap on the run-log tail returned by GET /api/runs/:id/log (last 64KB). */
export const RUN_LOG_TAIL_BYTES = 64 * 1024;

/**
 * Read the last `maxBytes` of a run log file as UTF-8 text. Returns null when the
 * file is missing/unreadable (the route maps that to a 404). Reading only the
 * tail (via stat + a positioned read) bounds memory regardless of log size — a
 * long-running, chatty run never balloons the response.
 */
export function readLogTail(path: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = Math.min(size, maxBytes);
    if (length === 0) return "";
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed / invalid — nothing to do.
      }
    }
  }
}
