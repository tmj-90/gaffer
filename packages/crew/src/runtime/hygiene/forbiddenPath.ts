// =====================================================================
// Delivery-hygiene forbidden-path policy — strangler port of runner/lib/hygiene.sh's
// _hygiene_forbidden_fragments + _hygiene_path_forbidden (P4 orchestration; a
// delivery SAFETY gate). Pure predicate, so the unit test IS the behaviour.
// ---------------------------------------------------------------------
// A delivery diff must not carry factory runtime residue (node_modules, .crew/,
// *.events.jsonl, .claude/, CLAUDE.factory.md, .mcp.json, mcp-runtime.*). The
// policy is a whitespace-separated fragment list (env HYGIENE_FORBIDDEN_PATHS,
// same default as the bash). A fragment beginning with `*` matches as a shell
// `case` GLOB against the whole path (`*.events.jsonl`); every other fragment
// matches as a literal SUBSTRING (`node_modules`, `.crew/`) — byte-for-byte the
// bash `case "$path" in ${frag})` (glob) vs `case "$path" in *"$frag"*)` (substring).
// =====================================================================

/** The bash default, kept in sync with hygiene.sh:30 / factory.config.sh. */
export const DEFAULT_FORBIDDEN_PATHS =
  "node_modules .crew/ *.events.jsonl .claude/ CLAUDE.factory.md .mcp.json mcp-runtime.";

/** Split HYGIENE_FORBIDDEN_PATHS on whitespace (the bash `set -f; for f in $raw`). */
export function parseFragments(raw: string): string[] {
  return raw.split(/\s+/).filter((f) => f !== "");
}

/**
 * Compile one shell `case` glob (no FNM_PATHNAME — `*`/`?` also match `/`, as in
 * bash `case`) to an anchored RegExp. Supports `*`, `?`, `[...]`/`[!...]` bracket
 * expressions, and `\` escapes; an unterminated `[` is a literal `[`.
 */
function globToRegExp(glob: string): RegExp {
  const esc = (ch: string): string => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === undefined) break;
    if (c === "*") {
      re += "[\\s\\S]*";
    } else if (c === "?") {
      re += "[\\s\\S]";
    } else if (c === "[") {
      // Find the closing ']' (a ']' immediately after '[' or '[!' is a literal member).
      let j = i + 1;
      let neg = false;
      if (glob[j] === "!" || glob[j] === "^") {
        neg = true;
        j += 1;
      }
      let cls = "";
      if (glob[j] === "]") {
        cls += "\\]";
        j += 1;
      }
      while (j < glob.length && glob[j] !== "]") {
        const ch = glob[j];
        if (ch === undefined) break;
        cls += /[\\^\]]/.test(ch) ? `\\${ch}` : ch;
        j += 1;
      }
      if (j >= glob.length) {
        re += "\\["; // no closing bracket → literal '['
      } else {
        re += `[${neg ? "^" : ""}${cls}]`;
        i = j;
      }
    } else if (c === "\\") {
      const n = glob[i + 1];
      if (n !== undefined) {
        re += esc(n);
        i += 1;
      } else {
        re += "\\\\";
      }
    } else {
      re += esc(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/** True iff `path` matches any forbidden fragment (glob for `*`-leading, else substring). */
export function isForbiddenPath(path: string, fragments: readonly string[]): boolean {
  for (const frag of fragments) {
    if (frag === "") continue;
    if (frag.startsWith("*")) {
      if (globToRegExp(frag).test(path)) return true;
    } else if (path.includes(frag)) {
      return true;
    }
  }
  return false;
}
