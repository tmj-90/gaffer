/**
 * Where a shell can be when each command of a command line runs: the directory flow the
 * read and write boundaries judge a RELATIVE path against.
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 *
 * A directory set is an array of canonical directories; a `null` element means "a
 * directory the hook cannot know" (a relative path there cannot be judged, so it fails
 * closed). A path is allowed only if it is allowed from EVERY directory in the set: an
 * uncertain directory is never resolved in the agent's favour.
 *
 * External review 20: the analysers kept ONE directory and moved it at every `cd`, so a
 * `cd` that did not move the shell running the next command still moved the analysis:
 * `cd R; (cd W); python3 -c 'open("x","w")...'` was judged as writing W/x and wrote R/x.
 * The rules here, by construction:
 *
 *  - A `cd` can fail (the agent decides whether its target exists), so after `cd X; next`
 *    `next` may run in X or where the shell was: both. Only a command joined to the `cd`
 *    by `&&` runs with the `cd` done, so `cd sub && cmd` judges `cmd` in `sub` alone, and
 *    `cd X || cmd` judges `cmd` where the shell was. (`!` swaps the two.)
 *  - A `cd` whose effect cannot be relied on (inside `( )`, `{ }`, if / case / while /
 *    for bodies, a pipeline element, a backgrounded list, a coprocess) only ADDS its
 *    directory: what follows is judged in both.
 *  - A command substitution and `sh -c` run in a child; their callers walk them on their
 *    own and never let them move this flow.
 *  - What the callers cannot bound marks the directory unknown: a relative `cd` in a loop
 *    body (it repeats), a function or trap body or alias holding a `cd` (it runs when
 *    called), `source`, `popd`, a `cd` the caller cannot resolve.
 *
 * Directory sets only grow across a list boundary (`;`, newline, `&`), and a scoped
 * change never removes a directory, so a mistake in reading the structure can only add
 * directories, never drop the one the shell is in.
 */

/**
 * Past this many directories the set is "unknown": it bounds the work (each relative
 * path is judged from every directory) and a set that large is no longer a proof.
 */
const MAX_DIRS = 16;

/** The union of directory sets (a null element, "unknown", is kept). */
function cwdUnion(...sets) {
  const out = [];
  for (const s of sets) {
    for (const d of s) {
      if (out.includes(d)) continue;
      out.push(d);
      if (out.length > MAX_DIRS) return [null];
    }
  }
  return out;
}

function sameSet(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((d) => b.includes(d));
}

/** Separators that end an and-or list (the next command starts from the whole flow). */
const PIPE = new Set(["|", "|&"]);
const AND_OR = new Set(["&&", "||"]);

class CwdFlow {
  /** `start`: the directory set the shell starts in. */
  constructor(start) {
    // Every directory the shell may be in at the current list boundary.
    this.outer = cwdUnion(start);
    // The current and-or list so far: where it may be if it succeeded / failed.
    this.list = null;
    // The input of the current pipeline (every element starts from it).
    this.pipeIn = null;
  }

  /** The directory set a command preceded by `sep` starts in. */
  input(sep) {
    if (this.list) {
      if (sep === "&&") return this.list.succ;
      if (sep === "||") return this.list.fail;
      if (PIPE.has(sep)) return this.pipeIn ?? this.outer;
      // A list the caller did not see end (a separator it could not read): close it.
      this.endList();
    }
    return this.outer;
  }

  /**
   * Record one command. `sep` / `nextSep`: the separators before and after it; `before`:
   * the set it started in (input()); `after`: the set if it succeeded (its own `cd`
   * applied, or `before`). `scoped`: its directory change cannot be relied on (see the
   * header); `negate`: it ran under `!`.
   */
  step(sep, nextSep, before, after, { scoped = false, negate = false } = {}) {
    const changed = !sameSet(before, after);
    let succ =
      changed && (scoped || PIPE.has(sep) || PIPE.has(nextSep)) ? cwdUnion(before, after) : after;
    let fail = changed ? cwdUnion(before, after) : before;
    if (negate) [succ, fail] = [fail, succ];
    const inList = this.list !== null && (AND_OR.has(sep) || PIPE.has(sep));
    if (PIPE.has(nextSep) && !PIPE.has(sep)) this.pipeIn = before;
    if (!inList) this.list = { succ, fail };
    else if (sep === "&&") this.list = { succ, fail: cwdUnion(this.list.fail, fail) };
    else if (sep === "||") this.list = { succ: cwdUnion(this.list.succ, succ), fail };
    else this.list = { succ: cwdUnion(this.list.succ, succ), fail: cwdUnion(this.list.fail, fail) };
    if (!AND_OR.has(nextSep) && !PIPE.has(nextSep)) this.endList();
  }

  /** A list boundary: the next command may start wherever the list could leave the shell. */
  endList() {
    if (this.list) this.outer = cwdUnion(this.outer, this.list.succ, this.list.fail);
    this.list = null;
    this.pipeIn = null;
  }

  /** From here on the directory is unknown. */
  poison() {
    this.outer = cwdUnion(this.outer, [null]);
    if (this.list) {
      this.list = {
        succ: cwdUnion(this.list.succ, [null]),
        fail: cwdUnion(this.list.fail, [null]),
      };
    }
    if (this.pipeIn) this.pipeIn = cwdUnion(this.pipeIn, [null]);
  }
}

/** A word that changes the directory of the shell that runs it. */
const CD_VERBS = new Set(["cd", "pushd", "popd"]);

/** Whether a command text (a trap, alias or eval body) may change directory. */
function textMayChangeDir(text) {
  return /(?:^|[^\w.-])(?:cd|pushd|popd|source)(?=$|[^\w.-])|(?:^|[;&|(){}\s])\.(?=\s)/.test(
    String(text),
  );
}

export { CD_VERBS, CwdFlow, MAX_DIRS, cwdUnion, textMayChangeDir };
