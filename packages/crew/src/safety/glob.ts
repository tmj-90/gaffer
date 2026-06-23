/**
 * Minimal glob matcher for safety path patterns. Supports `**` (any depth,
 * including zero segments), `*` (within a segment) and `?`. Matching is done on
 * normalised forward-slash relative paths. This is intentionally small — we only
 * need the subset used by safety policies, not a full glob engine.
 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — match across path separators (and an optional trailing slash).
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Normalise a path to forward slashes with no leading `./`. */
export function normaliseRelative(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * True when `relativePath` matches `pattern`. A bare filename pattern like
 * `package.json` also matches that file at any depth (so `web/package.json`
 * matches), reflecting how safety policies are written.
 */
export function matchesGlob(relativePath: string, pattern: string): boolean {
  const path = normaliseRelative(relativePath);
  const pat = normaliseRelative(pattern);
  if (globToRegExp(pat).test(path)) return true;
  // Bare path with no slash/glob: also match as a basename anywhere.
  if (!pat.includes("/") && !pat.includes("*")) {
    return path === pat || path.endsWith(`/${pat}`);
  }
  return false;
}

export function matchesAnyGlob(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(relativePath, pattern));
}
