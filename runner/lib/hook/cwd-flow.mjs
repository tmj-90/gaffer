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
    // Set by stick(): from here on every command may also run somewhere unknown.
    this.sticky = false;
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
    if (this.sticky) after = cwdUnion(after, [null]);
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

  /**
   * From here on, and for good, the directory is unknown: something defined here runs
   * later, when the hook cannot see it (a function or trap body that may change
   * directory, an alias, a redefined `cd`). A later absolute `cd` does not undo it, as
   * it does after poison(): the body may run after that `cd` too.
   */
  stick() {
    this.sticky = true;
    this.poison();
  }

  /** From here on the directory is unknown (until a `cd` the hook can follow). */
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

/**
 * Whether a command text (a trap, alias or eval body) may change directory, now or when
 * it runs later: it names a directory verb or `source`, defines something that runs
 * later (a function, a trap, an alias, `enable`), runs text of its own (`eval`), or holds
 * an expansion whose text the hook does not see (`trap "$T" DEBUG`).
 */
function textMayChangeDir(text) {
  return /(?:^|[^\w.-])(?:cd|pushd|popd|source|eval|trap|alias|enable|function|builtin|command)(?=$|[^\w.-])|(?:^|[;&|(){}\s])\.(?=\s)|\(\s*\)|[$`]/.test(
    String(text),
  );
}

/**
 * Names whose redefinition (a function or an alias) changes what the analysis reads as
 * a directory change: after `cd() { :; }` a `cd` no longer moves the shell, after
 * `cd() { builtin cd /x; }` it moves it somewhere else.
 */
const DIR_SENSITIVE_NAMES = new Set([
  ...CD_VERBS,
  "builtin",
  "command",
  "source",
  ".",
  "eval",
  "exec",
  "trap",
  "alias",
  "enable",
]);

/**
 * Whether the command may assign a variable whose NAME the hook does not see:
 * `declare "$n=v"`, `export "${x}ATH=v"`, `printf -v "$n"`, `read "$n"`, `${!n:=v}`. Any
 * variable, CDPATH and the one a `cd` operand names among them, may then hold anything.
 * One pass over the text.
 */
function dynamicAssignment(cmd) {
  const text = String(cmd);
  if (/\$\{![^}]*=/.test(text)) return true;
  for (const seg of text.split(/[\n;&|]/)) {
    const m =
      /(?:^|[^\w-])(declare|typeset|local|export|readonly|printf|read|mapfile|readarray|getopts)(?![\w-])/.exec(
        seg,
      );
    if (!m) continue;
    const words = seg
      .slice(m.index + m[0].length)
      .split(/[ \t]+/)
      .filter(Boolean);
    for (let k = 0; k < words.length; k += 1) {
      const w = words[k];
      if (m[1] === "printf") {
        if (/^-v/.test(w) && /[$`]/.test(w.length > 2 ? w : (words[k + 1] ?? ""))) return true;
        continue;
      }
      if (/^-/.test(w)) continue;
      const name = w.split("=")[0];
      if (/[$`]/.test(name)) return true;
    }
  }
  return false;
}

/**
 * Whether CDPATH may be set when a `cd` runs, which sends a relative name that does not
 * start with `.` somewhere the hook does not follow: set in the environment, named in
 * the command (quotes and backslashes do not hide it), or set by text the hook does not
 * read (`eval`, `source`, `.`, ANSI-C quoting, an assignment whose name it cannot see).
 */
function cdpathMaySet(cmd) {
  const text = String(cmd);
  return (
    Boolean(process.env.CDPATH) ||
    /CDPATH/.test(text.replace(/["'\\]/g, "")) ||
    /(?:^|[^\w-])(?:eval|source)(?![\w-])|(?:^|[;&|(){}\s])\.(?=\s)|\$'/.test(text) ||
    dynamicAssignment(text)
  );
}

/** A command word whose text the hook does not see (`$C`, `"$@"`, `$(...)`). */
function dynamicWord(text) {
  return /[$`]/.test(String(text));
}

export {
  CD_VERBS,
  CwdFlow,
  DIR_SENSITIVE_NAMES,
  MAX_DIRS,
  cdpathMaySet,
  cwdUnion,
  dynamicAssignment,
  dynamicWord,
  textMayChangeDir,
};
