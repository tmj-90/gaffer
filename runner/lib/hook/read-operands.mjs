/**
 * The read boundary after shell expansion: every operand a Bash command READS (read and
 * copy tools, `<` redirects, `find … -exec` start points, xargs-fed readers, `$(< f)`,
 * eval / sh -c / command-substitution bodies) is expanded the way the shell would expand
 * it (lib/hook/expand.mjs) and every resulting path goes through the same secret-path,
 * root and secret-directory checks as a literal operand. Plus the expansion-aware twin of
 * the "a secret path appears anywhere" rule: any word, in any position, that expands to
 * a secret path is refused unless its segment only lists or removes it.
 *
 * Policy (fail closed; F1 of the 2026-11 hook audit):
 *   - a match is judged like a literal operand: a secret path, a path outside the
 *     configured roots, or a directory that holds or sits above the factory's secrets
 *     (GAFFER_DATA, the MCP config dir, HOME) is refused;
 *   - an operand the hook cannot expand (a variable it does not know, $(...), $((...)),
 *     an xargs placeholder) is refused in every profile: such a value can carry `../`,
 *     so no literal prefix bounds what it names;
 *   - a glob with no match is judged by its literal prefix (a glob cannot climb out of
 *     it): refused when that prefix is a secret directory or sits outside the roots;
 *   - over a work cap (expand.mjs EXPAND_LIMITS) it is refused;
 *   - a relative operand after a cd the hook cannot follow is refused.
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  EXPAND_LIMITS,
  VarTable,
  expandAssignmentValue,
  expandWordFields,
  globField,
  globOptions,
  lexWord,
  newBudget,
  physicalPath,
} from "./expand.mjs";
import { SECRET_PATH, canonicalize, classifyRootAccess } from "./paths.mjs";
import {
  COPY_READ_VERBS,
  READ_TOOL_VERBS,
  SEARCH_VERBS,
  isTrackedEnvTemplate,
  searchFileOperands,
} from "./reads.mjs";
import { normalizeVerb, splitRedirectToken, tokenizeSegment, unquote } from "./shell.mjs";
import { ASSIGNMENT_TOKEN, extractShellDashCBodies, resolveEffectiveTokens } from "./verbs.mjs";

const NAME_THE_FILE =
  "name the file literally (no wildcard, brace or variable the hook cannot resolve)";
const MAX_NESTING = 3;

// Flags of the read tools whose VALUE is never a file (`head -n $N`, `cut -d /`).
// An unlisted flag's value stays an operand and is checked: fail closed.
const VALUE_FLAGS = {
  head: ["-n", "-c", "--lines", "--bytes"],
  tail: ["-n", "-c", "-s", "--lines", "--bytes", "--pid", "--sleep-interval"],
  od: ["-A", "-j", "-N", "-t", "-w", "-S"],
  xxd: ["-s", "-l", "-c", "-g", "-o", "-n"],
  strings: ["-n", "-t", "-e", "-T"],
  hexdump: ["-n", "-s", "-e"],
  nl: ["-b", "-d", "-h", "-i", "-l", "-n", "-s", "-v", "-w"],
  base64: ["-w"],
  base32: ["-w"],
  sort: ["-t", "-k", "-S", "-T", "-o", "--parallel"],
  uniq: ["-f", "-s", "-w"],
  diff: ["-U", "-C", "-L", "--label"],
  cp: ["-S", "--suffix"],
  mv: ["-S", "--suffix"],
  install: ["-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix"],
  rsync: ["-e", "--rsh", "--exclude", "--include", "--filter", "-f", "--chmod", "--chown"],
  less: ["-x", "-y", "-b", "-h", "-j", "-z"],
  sed: ["-l", "--line-length"],
  awk: ["-F", "-v"],
};
// A long option whose value names a file the tool reads (`--files-from=F`).
const FILE_VALUE_OPTION = /^--[\w-]*(?:file|from|input|include)[\w-]*=|^--in=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const INTERPRETERS = new Set([
  "node",
  "nodejs",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  "deno",
  "bun",
  "eval",
  "source",
  ".",
]);
const TAR_ALIASES = new Set(["bsdtar", "gtar", "star"]);
const SEVEN_ZIP = new Set(["7z", "7za", "7zr", "7zz"]);
const LEADING_KEYWORDS = new Set(["!", "then", "do", "else", "elif", "time", "coproc"]);
const OPENERS = new Set(["if", "while", "until", "case", "select", "{"]);
const CLOSERS = new Set(["fi", "done", "esac", "}"]);

// ---------------------------------------------------------------------------
// Segmenting: top-level commands with the separator in front of each, `$(...)`,
// backticks and `<(...)` kept whole, and here-document bodies set aside.
// ---------------------------------------------------------------------------
function splitCommand(cmd) {
  const segs = [];
  let cur = "";
  let sep = "";
  let heredocs = [];
  const pending = [];
  const push = (nextSep) => {
    segs.push({ text: cur, sep, heredocs });
    cur = "";
    heredocs = [];
    sep = nextSep;
  };
  const n = cmd.length;
  let i = 0;
  while (i < n) {
    const c = cmd[i];
    if (c === "'" || c === '"') {
      const close = cmd.indexOf(c, i + 1);
      const end = close === -1 ? n : close + 1;
      cur += cmd.slice(i, end);
      i = end;
      continue;
    }
    if (c === "\\") {
      cur += cmd.slice(i, i + 2);
      i += 2;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && cmd[i + 1] === "(") {
      let depth = 0;
      let k = i + 1;
      for (; k < n; k += 1) {
        const d = cmd[k];
        if (d === "'" || d === '"') {
          const close = cmd.indexOf(d, k + 1);
          if (close === -1) {
            k = n;
            break;
          }
          k = close;
          continue;
        }
        if (d === "(") depth += 1;
        else if (d === ")" && --depth === 0) break;
      }
      cur += cmd.slice(i, k + 1);
      i = k + 1;
      continue;
    }
    if (c === "`") {
      const close = cmd.indexOf("`", i + 1);
      const end = close === -1 ? n : close + 1;
      cur += cmd.slice(i, end);
      i = end;
      continue;
    }
    if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(cmd.slice(i));
      if (m) {
        const word = m[2] ?? m[3] ?? m[4];
        const quoted = m[2] !== undefined || m[3] !== undefined || /^<<-?[ \t]*\\/.test(m[0]);
        pending.push({ word, quoted, strip: m[1] === "-", owner: heredocs });
        cur += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (c === "\n") {
      if (pending.length) {
        // Here-document bodies follow this line, one after the other.
        let k = i + 1;
        for (const h of pending.splice(0)) {
          const lines = [];
          let done = false;
          while (k <= n && !done) {
            const nl = cmd.indexOf("\n", k);
            const end = nl === -1 ? n : nl;
            const line = cmd.slice(k, end);
            k = end + 1;
            if ((h.strip ? line.replace(/^\t+/, "") : line) === h.word) done = true;
            else lines.push(line);
            if (nl === -1) break;
          }
          h.owner.push({ body: lines.join("\n"), quoted: h.quoted });
        }
        push(";");
        i = k;
        continue;
      }
      push("\n");
      i += 1;
      continue;
    }
    if (c === "|" || c === "&" || c === ";") {
      // `&>` / `>&` / `|&` are redirections or a pipe, not a background separator.
      if (c === "&" && (cmd[i + 1] === ">" || cur.endsWith(">") || cur.endsWith("<"))) {
        cur += c;
        i += 1;
        continue;
      }
      let op = c;
      if ((c === "|" || c === "&") && cmd[i + 1] === c) op = c + c;
      else if (c === "|" && cmd[i + 1] === "&") op = "|";
      else if (c === ";" && cmd[i + 1] === ";") op = ";;";
      push(op);
      i += op.length + (c === "|" && cmd[i + 1] === "&" ? 1 : 0);
      continue;
    }
    cur += c;
    i += 1;
  }
  push("");
  return segs;
}

/** The bodies of `$(...)`, backticks and `<(...)` / `>(...)` in a segment text. */
function substitutionBodies(text) {
  const out = [];
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const c = text[i];
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) break;
      i = close;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && text[i + 1] === "(") {
      if (text[i + 2] === "(") continue; // $(( arithmetic ))
      let depth = 0;
      let k = i + 1;
      for (; k < n; k += 1) {
        if (text[k] === "(") depth += 1;
        else if (text[k] === ")" && --depth === 0) break;
      }
      out.push(text.slice(i + 2, k));
      i = k;
      continue;
    }
    if (c === "`") {
      const close = text.indexOf("`", i + 1);
      if (close === -1) break;
      out.push(text.slice(i + 1, close));
      i = close;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Redirections: the `<` read targets, and the words left once every redirect is gone.
// ---------------------------------------------------------------------------
function splitRedirects(tokens) {
  const words = [];
  const reads = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const tk = tokens[k];
    if (/^["']/.test(tk) || !/[<>]/.test(tk)) {
      words.push(tk);
      continue;
    }
    const parts = splitRedirectToken(tk);
    if (parts.length === 1) {
      words.push(tk);
      continue;
    }
    let idx = 0;
    if (!/^\d*(?:<<<|<<|<>|>>|<|>)&?$/.test(parts[0])) {
      words.push(parts[0]);
      idx = 1;
    }
    const op = parts[idx];
    let target = parts[idx + 1];
    if (target === undefined) {
      target = tokens[k + 1];
      k += 1;
    }
    if (target === undefined) break;
    if (/^\d*<>?$/.test(op) && !/^[-\d]+$/.test(target)) reads.push(target);
    // `<&N` / `>&N` duplicate a descriptor; `<<` / `<<<` take a delimiter or a word.
  }
  return { words, reads };
}

// ---------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------
function sensitiveDirs() {
  const out = [];
  const add = (p, holds) => {
    if (!p) return;
    try {
      out.push({ dir: canonicalize(resolve(p)), holds });
    } catch {
      /* unresolvable: nothing to compare */
    }
  };
  add(process.env.GAFFER_DATA, true);
  if (process.env.MCP_CONFIG) add(dirname(process.env.MCP_CONFIG), true);
  add(homedir(), false);
  return out;
}

/** Why a directory operand reaches the factory's or the operator's secrets, or null. */
function sensitiveDirReason(dir) {
  if (SECRET_PATH.test(dir + "/")) return `a secret directory: ${dir}`;
  for (const { dir: s, holds } of sensitiveDirs()) {
    if (dir === "/" || s.startsWith(dir + "/")) {
      return `a directory above ${holds ? "the factory's secret files" : "the home directory and its credential stores"} (${s}): ${dir}`;
    }
    if (dir === s) {
      return holds
        ? `the directory that holds the factory's secret files (dashboard token, MCP claim token): ${dir}`
        : `the home directory (its credential stores): ${dir}`;
    }
  }
  return null;
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// A recursive reader that FOLLOWS symlinks (grep -R, rg -L, find -L, cp -L, tar -h,
// rsync -L, zip -r) reads a link's target: walk the tree for a link that reaches a
// secret. Bounded; over the bound it is refused.
function linkedSecretReason(dir, roots) {
  const budget = { entries: 0 };
  const seen = new Set();
  const walk = (d, depth) => {
    if (seen.has(d)) return null;
    seen.add(d);
    if (depth > EXPAND_LIMITS.depth || seen.size > EXPAND_LIMITS.dirs) return "too deep";
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return null;
    }
    budget.entries += entries.length;
    if (budget.entries > EXPAND_LIMITS.entries) return "too large";
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        let target;
        try {
          target = canonicalize(p);
        } catch {
          return "unresolvable link";
        }
        if (SECRET_PATH.test(target) || SECRET_PATH.test(target + "/")) return `${p} -> ${target}`;
        if (roots.configured && classifyRootAccess(target, roots) === "outside") {
          return `${p} -> ${target} (outside the roots)`;
        }
        if (isDirectory(target)) {
          if (sensitiveDirReason(target)) return `${p} -> ${target}`;
          const why = walk(target, depth + 1);
          if (why) return why;
        }
      } else if (e.isDirectory()) {
        const why = walk(p, depth + 1);
        if (why) return why;
      }
    }
    return null;
  };
  const why = walk(dir, 0);
  if (!why) return null;
  if (/^too |^unresolvable/.test(why)) {
    return `a recursive read that follows symlinks over a tree the hook cannot check for links (${why}): ${dir}; drop the follow-links flag (grep -r, not -R)`;
  }
  return `a recursive read that follows a symlink to a secret or out of bounds: ${why}`;
}

// ---------------------------------------------------------------------------
// The walk.
// ---------------------------------------------------------------------------
class Walk {
  constructor(cmd, roots) {
    this.roots = roots;
    this.opts = globOptions(cmd);
    // CDPATH set in the environment or anywhere in the command (nested bodies included).
    this.cdpath = Boolean(process.env.CDPATH) || /\bCDPATH\b/.test(cmd);
    this.table = new VarTable(process.env, cmd);
    this.topCmd = cmd;
    this.stdinReader = false;
    // Set by `read` / `mapfile` / `readarray` and by a for loop over a substitution:
    // file names the hook cannot see reach any program, recognised reader or not.
    this.nameReader = false;
    this.dirWords = [];
    this.mentionWords = 0;
    // Work done for the read operands of the whole command (EXPAND_LIMITS.command), and
    // the verdict per operand already judged under the same variable values.
    this.work = 0;
    this.cache = new Map();
  }

  // ---- one read operand -------------------------------------------------------
  operandReason(raw, cwds, opts = {}) {
    const key = [raw, ...cwds, opts.follow, opts.placeholder, this.table.version].join("\0");
    if (this.cache.has(key)) return this.cache.get(key);
    const why = this.operandReasonUncached(raw, cwds, opts);
    this.cache.set(key, why);
    return why;
  }

  operandReasonUncached(raw, cwds, { follow = false, placeholder = null } = {}) {
    if (placeholder && raw.includes(placeholder)) {
      return `a read operand filled in by xargs from its input (${raw.slice(0, 60)}): the hook cannot see which file it names, so it is refused; ${NAME_THE_FILE}`;
    }
    const tk = raw.trim();
    if (!tk || tk === "-" || /^[&\d]+$/.test(tk)) return null;
    for (const cwd of cwds) {
      const r = expandWordFields(tk, this.table, [cwd]);
      if (r.unverifiable) {
        if (this.roots.configured) {
          return `read outside allowed roots (a ~user / ~- operand the hook cannot resolve): ${tk}`;
        }
        continue;
      }
      if (r.unknown) {
        return `read operand built at run time (${tk.slice(0, 80)}): an unknown variable, command substitution or arithmetic can name any file, so it is refused; ${NAME_THE_FILE}`;
      }
      if (r.capped) {
        return `read operand expands past the hook's limits (${tk.slice(0, 80)}); ${NAME_THE_FILE}`;
      }
      for (const field of r.fields) {
        const budget = newBudget();
        const g = globField(field, cwd, budget, this.opts);
        this.work += budget.entries + (g.paths ? g.paths.length : 1);
        if (this.work > EXPAND_LIMITS.command) {
          return `the read operands of this command expand past the hook's limits (at ${tk.slice(0, 80)}); split the command or ${NAME_THE_FILE}`;
        }
        if (g.kind === "unknown") {
          return `relative read operand after a cd the hook cannot follow (${tk.slice(0, 80)}); use an absolute path or a literal cd`;
        }
        if (g.kind === "dotdot") {
          return `read operand with a .. after a path that does not exist yet (${tk.slice(0, 80)}): the kernel resolves .. through whatever is created there; ${NAME_THE_FILE}`;
        }
        if (g.kind === "capped") {
          return `read operand glob matches past the hook's limits (${tk.slice(0, 80)}, in ${g.prefix}); ${NAME_THE_FILE}`;
        }
        if (g.kind === "nomatch") {
          const why = this.prefixReason(g.prefix, tk);
          if (why) return why;
          continue;
        }
        const paths = g.kind === "literal" ? [g.path] : g.paths;
        for (const p of paths) {
          if (p === "") continue;
          if (!p.startsWith("/") && cwd === null) {
            return `relative read operand after a cd the hook cannot follow (${tk.slice(0, 80)}); use an absolute path or a literal cd`;
          }
          // `..` is taken physically, as the kernel takes it: through a symlinked
          // directory `wt/..` is the link target's parent, not the worktree.
          const phys = physicalPath(p.startsWith("/") ? p : `${cwd ?? ""}/${p}`);
          if (phys === null) {
            return `read operand with a .. after a path that does not exist yet (${tk.slice(0, 80)}): the kernel resolves .. through whatever is created there; ${NAME_THE_FILE}`;
          }
          const why = this.pathReason(phys, tk, follow);
          if (why) return why;
        }
      }
    }
    return null;
  }

  pathReason(lexical, shown, follow) {
    if (lexical === "/dev" || lexical.startsWith("/dev/")) return null;
    const abs = canonicalize(lexical);
    if ((SECRET_PATH.test(abs) || SECRET_PATH.test(abs + "/")) && !isTrackedEnvTemplate(abs)) {
      return `bash read of a secret file (after shell expansion of ${shown.slice(0, 80)}): ${abs}`;
    }
    if (this.roots.configured && classifyRootAccess(abs, this.roots) === "outside") {
      return `read outside allowed roots (after shell expansion of ${shown.slice(0, 80)}): ${abs}`;
    }
    if (isDirectory(abs)) {
      const why = sensitiveDirReason(abs);
      if (why) return `bash read of ${why} (from ${shown.slice(0, 80)}); ${NAME_THE_FILE}`;
      if (follow) {
        const link = linkedSecretReason(abs, this.roots);
        if (link) return link;
      }
    }
    return null;
  }

  prefixReason(prefix, shown) {
    const abs = canonicalize(prefix);
    if (SECRET_PATH.test(abs + "/") || SECRET_PATH.test(abs)) {
      return `bash read glob inside a secret directory (${shown.slice(0, 80)}): ${abs}`;
    }
    for (const { dir, holds } of sensitiveDirs()) {
      if (holds && (dir === abs || dir.startsWith(abs + "/") || abs === "/")) {
        return `bash read glob over the directory that holds the factory's secret files (${shown.slice(0, 80)}): ${abs}; ${NAME_THE_FILE}`;
      }
    }
    if (this.roots.configured && classifyRootAccess(abs, this.roots) === "outside") {
      return `read outside allowed roots (glob in ${abs}: ${shown.slice(0, 80)})`;
    }
    return null;
  }

  // ---- any word: the expansion-aware "secret path anywhere" rule -------------------
  mentionReason(raw, cwds) {
    const lexed = lexWord(raw);
    const expandable =
      lexed.parts.some((p) => p.v !== undefined) ||
      lexed.parts.some((p) => !p.q && /[*?[{~]/.test(p.c));
    if (!expandable) {
      // A literal directory word still names where listed file names come from (see
      // nameReader / stdinReader in expandedReadReason).
      const text = lexed.unknown ? "" : lexed.parts.map((p) => p.c).join("");
      if (text.includes("/") && !text.startsWith("-")) {
        for (const cwd of cwds) {
          if (cwd === null && !text.startsWith("/")) continue;
          const abs = physicalPath(text.startsWith("/") ? text : `${cwd}/${text}`);
          if (abs !== null && isDirectory(abs)) this.dirWords.push({ abs: canonicalize(abs), raw });
        }
      }
      return null;
    }
    this.mentionWords += 1;
    for (const cwd of cwds) {
      const r = expandWordFields(raw, this.table, [cwd]);
      if (!r.fields) {
        // A changed IFS makes every unquoted variable unknown; for the directory words
        // (where listed names come from) the unsplit value is still a candidate.
        if (r.unknown && this.table.ifsChanged) {
          this.table.ifsChanged = false;
          const u = expandWordFields(raw, this.table, [cwd]);
          this.table.ifsChanged = true;
          for (const f of u.fields ?? []) {
            const t = f.map((p) => p.c).join("");
            const abs =
              t && (t.startsWith("/") || cwd !== null)
                ? physicalPath(t.startsWith("/") ? t : `${cwd}/${t}`)
                : null;
            if (abs !== null && isDirectory(abs))
              this.dirWords.push({ abs: canonicalize(abs), raw });
          }
        }
        continue;
      }
      for (const field of r.fields) {
        const budget = newBudget();
        // Past 64 glob words only the literal prefix of each is judged (time bound).
        const g = globField(field, cwd, budget, this.opts, this.mentionWords <= 64);
        if (g.kind === "capped") {
          if (g.prefix) {
            const why = this.prefixReason(g.prefix, raw);
            if (why && !why.startsWith("read outside")) return why;
          }
          continue;
        }
        if (g.kind !== "literal" && g.kind !== "paths") continue;
        const paths = g.kind === "literal" ? [g.path] : g.paths;
        for (const p of paths) {
          if (!p || (!p.startsWith("/") && cwd === null)) continue;
          const lexical = physicalPath(p.startsWith("/") ? p : `${cwd ?? ""}/${p}`);
          if (lexical === null || lexical.startsWith("/dev/")) continue;
          const abs = canonicalize(lexical);
          const dir = isDirectory(abs);
          if (
            (SECRET_PATH.test(abs) || (dir && SECRET_PATH.test(abs + "/"))) &&
            !isTrackedEnvTemplate(abs)
          ) {
            return `a word that expands to a secret path (${raw.slice(0, 80)} -> ${abs})`;
          }
          if (dir) this.dirWords.push({ abs, raw });
        }
      }
    }
    return null;
  }

  // ---- the read operands of one simple command ------------------------------------
  readOperands(eff) {
    // Other tar front ends read their operands as tar does.
    const verb = TAR_ALIASES.has(basename(eff.verb)) ? "tar" : basename(eff.verb);
    const args = eff.rest.slice(1);
    const out = [];
    let follow = false;
    let extraCwds = [];
    let placeholder = null;
    const plain = (list, valueFlags = []) => {
      for (let k = 0; k < list.length; k += 1) {
        const tk = normalizeVerb(list[k]);
        if (tk === "--") {
          out.push(...list.slice(k + 1));
          break;
        }
        if (FILE_VALUE_OPTION.test(tk)) {
          out.push(list[k].slice(list[k].indexOf("=") + 1));
          continue;
        }
        if (tk.startsWith("-") && tk !== "-") {
          if (valueFlags.includes(tk)) k += 1;
          continue;
        }
        out.push(list[k]);
      }
    };
    if (verb === "xargs" || verb === "parallel") {
      // The program xargs runs reads what xargs feeds it from stdin.
      let k = 0;
      while (k < args.length && normalizeVerb(args[k]).startsWith("-")) {
        const f = normalizeVerb(args[k]);
        let m;
        if ((m = /^-[0prtx]*[IJ](.*)$/.exec(f))) {
          placeholder = m[1] || unquote(args[k + 1] ?? "");
          k += m[1] ? 1 : 2;
          continue;
        }
        if ((m = /^-[0prtx]*i(.*)$/.exec(f)) || (m = /^--replace(?:=(.*))?$/.exec(f))) {
          placeholder = m[1] || "{}";
          k += 1;
          continue;
        }
        k +=
          /^-(?:[nLPsdEaS]|-max-args|-max-lines|-max-procs|-delimiter|-arg-file|-eof|j|-jobs)$/.test(
            f,
          )
            ? 2
            : 1;
      }
      const inner = resolveEffectiveTokens(args.slice(k));
      if (inner) {
        const sub = this.readOperands(inner);
        const iv = basename(inner.verb);
        // Whatever xargs runs gets the names (`xargs gzip -c` reads as `xargs cat` does).
        if (iv) this.stdinReader = true;
        return { ...sub, placeholder: placeholder || (verb === "parallel" ? "{" : null) };
      }
      return { operands: [], follow, extraCwds, placeholder };
    }
    if (verb === "cpio" || verb === "afio") {
      // `find DIR | cpio -o` archives every name fed on stdin (the xargs case).
      if (args.some((t) => /^-[A-Za-z]*[op]|^--(?:create|pass-through)$/.test(normalizeVerb(t)))) {
        this.stdinReader = true;
      }
      return { operands: out, follow, extraCwds, placeholder };
    }
    if (verb === "pax") {
      // `pax -w DIR` writes an archive of DIR to stdout; with no operand it reads names
      // from stdin.
      const write = args.some((t) => /^-[A-Za-z]*w/.test(normalizeVerb(t)));
      plain(args, ["-f", "-s", "-x", "-b", "-o", "-B", "-G", "-T", "-U", "-p"]);
      if (write && out.length === 0) this.stdinReader = true;
      return {
        operands: out,
        follow: args.some((t) => /^-[A-Za-z]*[LH]/.test(normalizeVerb(t))),
        extraCwds,
        placeholder,
      };
    }
    if (SEVEN_ZIP.has(verb)) {
      // `7z a ARCHIVE FILES...`: the files after the archive are read (`-i@list`, `@list`
      // read a list file; it and every operand are judged).
      const ops = args.filter((t) => !normalizeVerb(t).startsWith("-"));
      out.push(...ops.slice(2).map((t) => t.replace(/^(['"]?)@/, "$1")));
      for (const t of args) {
        const m = /^(['"]?)-[ix]!?(?:r[-0]?)?@(.+)$/.exec(t);
        if (m) out.push(m[1] + m[2]);
      }
      return { operands: out, follow, extraCwds, placeholder };
    }
    if (verb === "git" && args.some((t) => normalizeVerb(t) === "--no-index")) {
      // `git grep --no-index PATTERN PATH...` / `git diff --no-index A B` read any file.
      let k = 0;
      while (k < args.length && normalizeVerb(args[k]).startsWith("-"))
        k += /^-[Cc]$/.test(normalizeVerb(args[k])) ? 2 : 1;
      const sub = normalizeVerb(args[k] ?? "");
      const ops = args.slice(k + 1).filter((t) => !normalizeVerb(t).startsWith("-"));
      if (sub === "grep") {
        const explicit = args.some((t) =>
          /^-[ef]$|^--(?:regexp|file)(?:=|$)/.test(normalizeVerb(t)),
        );
        out.push(...(explicit ? ops : ops.slice(1)));
        if (!ops.slice(explicit ? 0 : 1).length) out.push(".");
      } else if (sub === "diff") out.push(...ops);
      return { operands: out, follow, extraCwds, placeholder };
    }
    if (verb === "dd") {
      for (const t of args)
        if (/^if=/.test(normalizeVerb(t))) out.push(t.replace(/^(['"]?)if=/, "$1"));
    } else if (SEARCH_VERBS.has(verb)) {
      const files = searchFileOperands(args);
      const flags = args.filter((t) => normalizeVerb(t).startsWith("-")).map(normalizeVerb);
      const recursive =
        verb === "rg" ||
        verb === "ag" ||
        verb === "ack" ||
        flags.some(
          (f) => /^-[A-Za-z]*[rR]/.test(f) || /^--(?:recursive|dereference-recursive)$/.test(f),
        );
      follow = flags.some((f) =>
        (verb === "rg" ? /^-[A-Za-z]*L|^--follow$/ : /^-[A-Za-z]*R|^--dereference-recursive$/).test(
          f,
        ),
      );
      out.push(...files);
      if (recursive && files.length === 0) out.push(".");
      for (const t of args)
        if (FILE_VALUE_OPTION.test(normalizeVerb(t))) out.push(t.slice(t.indexOf("=") + 1));
    } else if (verb === "sed" || verb === "awk" || verb === "gawk" || verb === "mawk") {
      // The script is the first operand unless -e / -f (sed) or -f (awk) gave it.
      const isSed = verb === "sed";
      let scripted = false;
      const files = [];
      for (let k = 0; k < args.length; k += 1) {
        const tk = normalizeVerb(args[k]);
        if (tk === "--") {
          files.push(...args.slice(k + 1));
          break;
        }
        if (/^--(?:expression|source)=/.test(tk)) {
          scripted = true;
          continue;
        }
        if (/^--file=/.test(tk)) {
          scripted = true;
          out.push(args[k].slice(args[k].indexOf("=") + 1));
          continue;
        }
        if (tk.startsWith("-") && tk.length > 1) {
          const letters = tk.slice(1);
          const valueAt = [...letters].findIndex((c) =>
            isSed
              ? c === "e" || c === "f" || c === "l"
              : c === "f" || c === "F" || c === "v" || c === "e",
          );
          if (valueAt === -1) continue;
          const c = letters[valueAt];
          const attached = letters.slice(valueAt + 1);
          const value = attached || args[k + 1];
          if (!attached) k += 1;
          if (c === "e") scripted = true;
          if (c === "f") {
            scripted = true;
            if (value !== undefined) out.push(value);
          }
          continue;
        }
        files.push(args[k]);
      }
      const rest = scripted ? files : files.slice(1);
      for (const f of rest) if (isSed || !ASSIGNMENT_TOKEN.test(normalizeVerb(f))) out.push(f);
    } else if (verb === "find") {
      const actions = args.map(normalizeVerb);
      if (actions.some((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a))) {
        let k = 0;
        while (k < args.length && /^-(?:[HLP]|D|O\d*)$/.test(actions[k])) {
          if (actions[k] === "-L") follow = true;
          k += actions[k] === "-D" ? 2 : 1;
        }
        const starts = [];
        while (k < args.length && !/^[-(!,]|^\\[(!]/.test(actions[k])) starts.push(args[k++]);
        out.push(...(starts.length ? starts : ["."]));
        if (actions.some((a) => a === "-follow")) follow = true;
      }
    } else if (READ_TOOL_VERBS.has(verb) || COPY_READ_VERBS.has(verb)) {
      plain(args, VALUE_FLAGS[verb] ?? []);
      const flags = args.map(normalizeVerb).filter((f) => f.startsWith("-"));
      const first = normalizeVerb(args[0] ?? "");
      if (verb === "cp") follow = flags.some((f) => /^-[A-Za-z]*L|^--dereference$/.test(f));
      if (verb === "tar") {
        follow =
          flags.some((f) => /^-[A-Za-z]*h|^--dereference$/.test(f)) ||
          /^[a-z]*h[a-z]*$/.test(first);
        for (let k = 0; k < args.length; k += 1) {
          const f = normalizeVerb(args[k]);
          if ((f === "-C" || f === "--directory") && args[k + 1]) extraCwds.push(args[k + 1]);
          else if (f.startsWith("--directory="))
            extraCwds.push(args[k].slice(args[k].indexOf("=") + 1));
        }
      }
      if (verb === "rsync")
        follow = flags.some((f) =>
          /^-[A-Za-z]*[Lk]|^--copy-(?:links|dirlinks|unsafe-links)$/.test(f),
        );
      if (verb === "zip") follow = !flags.some((f) => /^-[A-Za-z]*y|^--symlinks$/.test(f));
      if (verb === "ln" && out.length > 1) extraCwds = ["@ln"];
    }
    return { operands: out, follow, extraCwds, placeholder };
  }

  // ---- a whole command ----------------------------------------------------------
  commandReason(cmd, startCwds, nesting = 0) {
    if (nesting > MAX_NESTING) return null;
    const segs = splitCommand(cmd);
    let cwds = startCwds.slice();
    let depth = 0;
    const nestedCwds = new Set(cwds);
    const bodies = [];
    for (let s = 0; s < segs.length; s += 1) {
      const seg = segs[s];
      const nextSep = segs[s + 1]?.sep ?? "";
      bodies.push(...substitutionBodies(seg.text));
      let tokens = tokenizeSegment(seg.text.trim());
      // Subshell / group parentheses and braces glued to words.
      if (tokens.length && /^\(+/.test(tokens[0]) && !/^\(\(/.test(tokens[0])) {
        const m = /^\(+/.exec(tokens[0])[0];
        depth += m.length;
        tokens[0] = tokens[0].slice(m.length);
        if (!tokens[0]) tokens = tokens.slice(1);
      }
      let closing = 0;
      if (tokens.length) {
        const last = tokens[tokens.length - 1];
        const m = /\)+$/.exec(last);
        if (m && depth > 0 && !/^["']/.test(last) && !/\$\(|\(/.test(last)) {
          closing = Math.min(m[0].length, depth);
          tokens[tokens.length - 1] = last.slice(0, last.length - closing);
          if (!tokens[tokens.length - 1]) tokens.pop();
        }
      }
      const definite = () =>
        depth === 0 && !["||", "|", "&"].includes(seg.sep) && nextSep !== "|" && nextSep !== "&";
      // Leading keywords.
      for (;;) {
        const w = normalizeVerb(tokens[0] ?? "");
        if (LEADING_KEYWORDS.has(w)) tokens = tokens.slice(1);
        else if (OPENERS.has(w)) {
          depth += 1;
          tokens = tokens.slice(1);
        } else if (CLOSERS.has(w)) {
          depth = Math.max(0, depth - 1);
          tokens = tokens.slice(1);
        } else break;
      }
      const { words, reads } = splitRedirects(tokens);
      // Function definitions open a body.
      if (
        words.length &&
        (/^[A-Za-z_][\w.:-]*\(\)\{?$/.test(words[0]) || words[0] === "function")
      ) {
        depth += 1;
        words.splice(0, words[0] === "function" ? 2 : 1);
        if (words[0] === "{") words.shift();
      }
      const w0 = normalizeVerb(words[0] ?? "");
      // Redirect read targets are read operands of any command.
      for (const r of reads) {
        const why = this.operandReason(r, cwds);
        if (why) return why;
      }
      // Here-document bodies: code when a shell or interpreter reads them.
      const consumer = (w) => SHELLS.has(basename(w)) || INTERPRETERS.has(basename(w));
      const nextWord = normalizeVerb(tokenizeSegment((segs[s + 1]?.text ?? "").trim())[0] ?? "");
      for (const h of seg.heredocs) {
        if (consumer(w0) || (nextSep === "|" && consumer(nextWord))) bodies.push(h.body);
        else if (!h.quoted) bodies.push(...substitutionBodies(h.body));
      }
      if (w0 === "for" || w0 === "select") {
        depth += 1;
        const name = words[1];
        const inAt = words.findIndex((x, k) => k >= 2 && normalizeVerb(x) === "in");
        if (name && /^[A-Za-z_]\w*$/.test(name)) {
          if (w0 === "select" || inAt === -1) this.table.assign(name, null, false, cwds);
          else {
            const values = [];
            let unknown = false;
            for (const raw of words.slice(inAt + 1)) {
              const why = this.mentionReason(raw, cwds);
              if (why) return why;
              // Once the list is longer than a variable may hold, the loop variable is
              // unknown and its words need no more expanding.
              for (const cwd of unknown ? [] : cwds) {
                const r = expandWordFields(raw, this.table, [cwd]);
                if (!r.fields) {
                  if (r.unknown) this.nameReader = true;
                  unknown = true;
                  break;
                }
                for (const f of r.fields) {
                  const g = globField(f, cwd, newBudget(), this.opts);
                  if (g.kind === "literal") values.push(g.path);
                  else if (g.kind === "paths") values.push(...g.paths);
                  else if (g.kind === "nomatch") values.push(f.map((p) => p.c).join(""));
                  else unknown = true;
                }
                if (values.length > EXPAND_LIMITS.variants) unknown = true;
              }
            }
            this.table.assign(name, unknown ? null : values, false, cwds);
          }
        }
        continue;
      }
      if (w0 === "case") {
        depth += 1;
        continue;
      }
      // Assignments, alone or in front of a command; export / declare / local forms.
      let j = 0;
      if (["export", "declare", "local", "readonly", "typeset"].includes(w0)) {
        j = 1;
        let flagsOk = true;
        while (j < words.length && words[j].startsWith("-")) {
          if (!/^-[xrg]+$/.test(words[j])) flagsOk = false;
          j += 1;
        }
        for (; j < words.length; j += 1) {
          const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(words[j]);
          if (!m) continue;
          const v = flagsOk ? expandAssignmentValue(m[2], this.table, cwds) : null;
          this.table.assign(m[1], v, definite(), cwds);
        }
        continue;
      }
      while (j < words.length && ASSIGNMENT_TOKEN.test(words[j])) j += 1;
      const prefixOnly = j === words.length;
      for (const a of words.slice(0, j)) {
        const eq = a.indexOf("=");
        const name = a.slice(0, eq).replace(/\+$/, "");
        const v =
          a[eq - 1] === "+" ? null : expandAssignmentValue(a.slice(eq + 1), this.table, cwds);
        this.table.assign(name, v, prefixOnly && definite(), cwds);
      }
      if (prefixOnly) {
        depth = Math.max(0, depth - closing);
        continue;
      }
      const cmdWords = words.slice(j);
      const verb0 = basename(normalizeVerb(cmdWords[0]));
      if (verb0 === "unset") {
        for (const name of cmdWords.slice(1)) {
          if (/^[A-Za-z_]\w*$/.test(name)) this.table.assign(name, [""], definite(), cwds);
        }
        continue;
      }
      // cd / pushd / popd: the cwds later relative operands resolve against.
      if (verb0 === "cd" || verb0 === "pushd" || verb0 === "popd") {
        const next = [];
        if (verb0 === "popd") next.push(null);
        else {
          let k = 1;
          while (k < cmdWords.length && /^-[LPe@]+$/.test(normalizeVerb(cmdWords[k]))) k += 1;
          if (cmdWords[k] === "--") k += 1;
          const arg = cmdWords[k];
          if (arg === undefined) next.push(verb0 === "cd" ? canonicalize(homedir()) : null);
          else if (/^[-+]/.test(unquote(arg))) next.push(null);
          else {
            for (const cwd of cwds) {
              const r = expandWordFields(arg, this.table, [cwd]);
              const fields = r.fields ?? [];
              if (!r.fields || fields.length !== 1) {
                next.push(null);
                continue;
              }
              const g = globField(fields[0], cwd, newBudget(), this.opts);
              const p =
                g.kind === "literal"
                  ? g.path
                  : g.kind === "paths" && g.paths.length === 1
                    ? g.paths[0]
                    : null;
              if (p === null || (!p.startsWith("/") && cwd === null)) next.push(null);
              else {
                // Both the logical cd (bash's default: `..` taken lexically) and the
                // physical one (`cd -P`, `set -P`): through a symlink they differ.
                const raw = p.startsWith("/") ? p : `${cwd ?? ""}/${p}`;
                next.push(canonicalize(resolve(raw)));
                const phys = physicalPath(raw);
                next.push(phys === null ? null : canonicalize(phys));
                // CDPATH (from the environment or set by the command) sends a relative
                // name that does not start with `.` somewhere the hook does not follow.
                if (this.cdpath && !/^\.\.?(?:\/|$)/.test(p) && !p.startsWith("/")) next.push(null);
              }
            }
          }
        }
        cwds = definite() ? [...new Set(next)] : [...new Set([...cwds, ...next])];
        for (const c of cwds) {
          nestedCwds.add(c);
          if (c !== null) this.dirWords.push({ abs: c, raw: `cd ${unquote(cmdWords[1] ?? "")}` });
        }
        depth = Math.max(0, depth - closing);
        continue;
      }
      const eff = resolveEffectiveTokens(cmdWords);
      if (eff && /^(?:read|mapfile|readarray)$/.test(basename(eff.verb))) this.nameReader = true;
      if (eff) {
        const verb = basename(eff.verb);
        // eval runs its arguments as a command line.
        if (verb === "eval" && eff.rest.length > 1) {
          bodies.push(eff.rest.slice(1).map(unquote).join(" "));
        }
        const governed =
          /^(?:ls|stat|file|rm)$/.test(verb) ||
          (verb === "git" && /^(?:rm|status|ls-files)$/.test(normalizeVerb(eff.rest[1] ?? "")));
        // Judged on the whole command: a listing inside `$(ls DIR)` feeds a loop.
        const plainCmd = !/[|`<]|\$\(|\bxargs\b/.test(this.topCmd);
        if (!(governed && plainCmd)) {
          for (const w of eff.rest) {
            const why = this.mentionReason(w, cwds);
            if (why) return why;
          }
        }
        // eval / source / . can set any variable: nothing is known after them.
        if (verb === "eval" || verb === "source" || verb === ".") this.table.forgetAll();
        const { operands, follow, extraCwds, placeholder } = this.readOperands(eff);
        let opCwds = cwds;
        if (extraCwds.length) {
          const more = [];
          if (extraCwds[0] === "@ln") {
            const dest = operands[operands.length - 1];
            for (const cwd of cwds) {
              const r = expandWordFields(dest, this.table, [cwd]);
              const f = r.fields?.length === 1 ? r.fields[0].map((p) => p.c).join("") : null;
              if (f === null || cwd === null) more.push(null);
              else {
                const abs = resolve(cwd, f);
                more.push(isDirectory(abs) ? abs : dirname(abs));
              }
            }
          } else {
            for (const raw of extraCwds) {
              for (const cwd of cwds) {
                const r = expandWordFields(raw, this.table, [cwd]);
                const f = r.fields?.length === 1 ? r.fields[0].map((p) => p.c).join("") : null;
                more.push(
                  f === null || (cwd === null && !f.startsWith("/"))
                    ? null
                    : physicalPath(f.startsWith("/") ? f : `${cwd ?? ""}/${f}`),
                );
              }
            }
          }
          opCwds = [...new Set([...cwds, ...more])];
        }
        for (const op of operands) {
          const why = this.operandReason(op, opCwds, { follow, placeholder });
          if (why) return why;
        }
      }
      depth = Math.max(0, depth - closing);
    }
    // sh -c bodies, eval arguments, $( ), backticks, <( ) and shell-read here-documents.
    for (const body of [...extractShellDashCBodies(cmd), ...bodies]) {
      const why = this.commandReason(body, [...nestedCwds], nesting + 1);
      if (why) return why;
    }
    return null;
  }
}

/**
 * Why the command reads something it must not once the shell has expanded its words,
 * or null. `roots` is resolveRoots(); the cwd is process.cwd().
 */
export function expandedReadReason(cmd, roots) {
  const walk = new Walk(cmd, roots);
  const why = walk.commandReason(cmd, [canonicalize(process.cwd())]);
  if (why) return why;
  // A reader fed its file names on stdin (`… | xargs cat`): a word upstream that names
  // a directory holding secrets is where those names come from.
  if (walk.stdinReader) {
    for (const { abs, raw } of walk.dirWords) {
      const s = sensitiveDirReason(abs);
      if (s)
        return `file names fed on stdin to a reader (xargs, cpio, pax) come from ${s} (word ${raw.slice(0, 60)}); ${NAME_THE_FILE}`;
    }
  }
  // File names read by `read` / `mapfile` or a for loop over a substitution
  // (`find $GAFFER_DATA -type f | while read f; do gzip -c "$f"; done`): they reach any
  // program, so a listing of a directory that holds secrets is refused whatever reads.
  if (walk.nameReader) {
    for (const { abs, raw } of walk.dirWords) {
      const s = sensitiveDirReason(abs);
      if (s)
        return `file names read by a loop (read, mapfile, for over a substitution) come from ${s} (word ${raw.slice(0, 60)}); ${NAME_THE_FILE}`;
    }
  }
  return null;
}

export { splitCommand };
