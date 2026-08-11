// =====================================================================
// Worktree-leaf derivation — strangler port of tick.sh's per-repo worktree-key
// sanitizer (runner/tick.sh:1333-1336, the WT_ROWS build loop). P4 orchestration.
// ---------------------------------------------------------------------
// Each WRITE repo gets a throwaway git worktree under $WORKTREES_BASE, keyed by a
// deterministic, filesystem-safe leaf derived from the repo id (fallback: the repo
// name, fallback: a positional "repo<index>"). Determinism is load-bearing: a
// re-run must target the SAME dir so worktree setup is idempotent.
//
// BYTE-IDENTICAL to the bash:
//   __wt_key="${rid:-$rname}"                       # id, else name
//   [ -n "$__wt_key" ] || __wt_key="repo$__wt_idx"  # else repo<index>
//   __wt_key="$(printf %s "$__wt_key" | tr -c 'A-Za-z0-9._-' '-' | sed -E 's/-+/-/g; s/^-+//; s/-+$//')"
//   [ -n "$__wt_key" ] || __wt_key="repo$__wt_idx"  # sanitized-to-empty → repo<index>
//
// The `tr -c` is BYTE-oriented (it replaces every byte NOT in the allowed set),
// so the sanitizer operates on the raw UTF-8 bytes — a multibyte char becomes one
// '-' PER BYTE (then the sed collapse folds the run to a single '-'), exactly as
// tr+sed would. A JS `String.replace(/[^…]/g …)` would instead collapse a
// multibyte char to ONE '-' (char-oriented) and drift; hence the byte loop.
// =====================================================================

/** True iff a byte is in tr's allowed set `A-Za-z0-9._-`. */
function isAllowed(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x30 && b <= 0x39) || // 0-9
    b === 0x2e || // .
    b === 0x5f || // _
    b === 0x2d // -
  );
}

/** `tr -c 'A-Za-z0-9._-' '-'` then `sed -E 's/-+/-/g; s/^-+//; s/-+$//'`, byte-exact. */
function sanitizeLeaf(raw: string): string {
  const bytes = Buffer.from(raw, "utf8");
  const mapped = Buffer.from(Array.from(bytes, (b) => (isAllowed(b) ? b : 0x2d)));
  return mapped.toString("latin1").replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

/**
 * Derive the deterministic worktree leaf for a write repo.
 * @param id    the repo id (primary key; may be "")
 * @param name  the repo display name (fallback when id is "")
 * @param index the 0-based positional index (fallback "repo<index>")
 */
export function worktreeKey(id: string, name: string, index: number): string {
  let key = id !== "" ? id : name; // ${rid:-$rname}
  if (key === "") key = `repo${index}`; // [ -n ] || repo<index>
  key = sanitizeLeaf(key);
  if (key === "") key = `repo${index}`; // sanitized-to-empty → repo<index>
  return key;
}
