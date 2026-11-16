/**
 * The inline programs a Bash command hands to an interpreter, as the interpreter will
 * receive them: `python3 -c PROG`, `node -e PROG` (also `-p`, `--eval`, `--print`,
 * `--eval=PROG`), `deno eval PROG`, `bun -e PROG`, `ruby -e PROG` (every `-e`), `perl
 * -e PROG` (also `-E`, `-ne`, `-lane`, ...), `php -r PROG` (and `-B`/`-R`/`-E`), and a
 * program fed on stdin by a here-document, a here-string or `echo`/`printf` in a pipe.
 *
 * The command is read by a shell lexer of its own (the other shell helpers keep
 * backslashes and quotes for the deny rules): single quotes, double quotes with their
 * backslash escapes (`"open(\"/etc/x\",\"w\")"` is `open("/etc/x","w")`), `$'...'`,
 * backslashes, here-documents and here-strings. Every way the hook already follows a
 * command is followed here too: assignments and no-op wrappers (resolveEffectiveTokens),
 * `env -S` / `env -C`, `xargs`, `parallel`, `find -exec`, `fd -x`, the command runners
 * (`watch`, `flock`, `strace`, `timeout`, `nohup`, ...), `sh -c` / `bash -c` bodies,
 * `eval`, programs on stdin of a shell, and `cd` (so a relative path in a program is
 * resolved where the program runs).
 *
 * What it cannot read it reports as a reason, and the caller refuses: a program built by
 * a command substitution, filled in by xargs or find from input, taken from a variable
 * the command sets at run time, or arriving on stdin from a command the hook cannot read
 * (`curl ... | python3`, `xargs python3 -c`).
 *
 * Part of the safety hook's decision; see the map in runner/safety-hook-core.mjs.
 */

import { basename } from "node:path";
import { decodeEscapes } from "./inline-lex.mjs";
import { FD_PATH, otherInterpreter, otherInterpreterName } from "./inline-other.mjs";
import { replayCd } from "./paths.mjs";
import { CD_VERBS, CwdFlow, cwdUnion, textMayChangeDir } from "./cwd-flow.mjs";
import { resolveEffectiveTokens } from "./verbs.mjs";

const MAX_DEPTH = 6;

/** The language of an interpreter program name, or null. */
function interpreterLang(word) {
  const b = basename(word);
  if (/^(?:python|pypy)[0-9.]*$/.test(b)) return "python";
  if (/^(?:node|nodejs)(?:-?[0-9][0-9.]*)?$/.test(b)) return "js"; // node22, node-20.1
  if (/^(?:bun|tsx|ts-node|ts-node-esm|esno|esr|babel-node)$/.test(b)) return "js";
  if (b === "deno") return "deno";
  if (/^(?:ruby|jruby|truffleruby|irb)[0-9.]*$/.test(b)) return "ruby";
  if (/^perl[0-9.]*$/.test(b)) return "perl";
  if (/^php[0-9.]*(?:-cli)?$/.test(b)) return "php";
  return null;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash", "posh"]);
// Programs whose arguments are data: an interpreter name among them is not run.
const DATA_PROGRAMS = new Set([
  "echo",
  "printf",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "git",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "yq",
  "test",
  "[",
  "[[",
  "true",
  "false",
  "which",
  "type",
  "whereis",
  "man",
  "help",
  "ls",
  "file",
  "stat",
  "touch",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "ln",
  "chmod",
  "diff",
  "read",
  "export",
  "declare",
  "local",
  "readonly",
  "typeset",
  "unset",
  "alias",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "pwd",
  "cd",
  "pushd",
  "popd",
  "exit",
  "return",
  "shift",
  "set",
  "trap",
]);

// ---------------------------------------------------------------------
// SHELL LEXER
// ---------------------------------------------------------------------

/**
 * Lex a shell command into simple commands: { words, redirs, op } where `op` is the
 * operator that ended it (`|`, `|&`, `;`, `&&`, `||`, `&`, newline, `(`, `)`). A word is
 * { text, subst, vars, dynamic }: its text with quotes and backslashes removed and
 * expansions kept as written (`$X`, `$(...)`), whether it holds a command substitution,
 * the variable names it expands, and whether it holds something the lexer does not
 * decode. Linear in the command length.
 */
function lexShell(cmd) {
  const cmds = [];
  let words = [];
  let redirs = [];
  let word = null;
  let pendingRedir = null;
  const heredocs = [];
  // The command text of every substitution (`$(...)`, backticks, `<(...)`, `>(...)`,
  // `${X:-$(...)}`, and those in an unquoted here-document): the shell runs each of them
  // before or beside the command, so the caller reads them as commands too.
  const substs = [];
  const n = cmd.length;
  let i = 0;

  const newWord = () => {
    if (!word) word = { text: "", subst: false, vars: [], dynamic: false, quoted: false };
  };
  const endWord = () => {
    if (!word) return;
    word.vars = [...new Set(word.vars)];
    if (pendingRedir) {
      pendingRedir.word = word;
      if (pendingRedir.op === "<<" || pendingRedir.op === "<<-") heredocs.push(pendingRedir);
      redirs.push(pendingRedir);
      pendingRedir = null;
    } else words.push(word);
    word = null;
  };
  // THE DIRECTORY FLOW (cwd-flow.mjs) reads, for each command, the separator in front of
  // it (`sep`: an empty `(` keeps the one before it, so `a && (b)` runs b after a) and
  // how many subshell parentheses are open around it (`parenDepth`). `f (` with words
  // in front is a function header (`fnHeader`), whose `)` closes no subshell.
  let pendingSep = "";
  let parenDepth = 0;
  const parens = [];
  const closeParen = () => {
    if (parens.pop() === "sub") parenDepth = Math.max(0, parenDepth - 1);
  };
  const endCmd = (op) => {
    endWord();
    if (words.length || redirs.length) {
      cmds.push({ words, redirs, op, sep: pendingSep, parenDepth, fnHeader: op === "(" });
      pendingSep = op;
      if (op === "(") parens.push("fn");
      else if (op === ")") closeParen();
    } else if (cmds.length && (op === "|" || op === "|&")) {
      cmds[cmds.length - 1].op = op;
      pendingSep = op;
    } else if (op === "(") {
      parens.push("sub");
      parenDepth += 1;
    } else if (op === ")") {
      closeParen();
      pendingSep = ")";
    } else if (!(op === "\n" && /^(?:&&|\|\||\||\|&)$/.test(pendingSep))) {
      // A newline after `&&` / `||` / `|` continues the list.
      pendingSep = op;
    }
    words = [];
    redirs = [];
  };

  // An expansion starting at `$` (i points at `$`): append its raw text; return the new index.
  const expansion = (k) => {
    const nx = cmd[k + 1];
    if (nx === "(") {
      const end = matchParen(cmd, k + 1);
      word.text += cmd.slice(k, end);
      word.subst = true;
      substs.push(cmd.slice(k + 2, Math.max(k + 2, end - 1)));
      return end;
    }
    if (nx === "{") {
      const end = matchBrace(cmd, k + 1);
      const inner = cmd.slice(k + 2, end - 1);
      word.text += cmd.slice(k, end);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) word.vars.push(inner);
      else {
        word.subst = true; // `${X:-$(cmd)}`, `${!X}`, `${X/a/b}`: not followed as a value
        substs.push(inner); // but a substitution inside it still runs
      }
      return end;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(cmd.slice(k + 1, k + 257));
    if (m) {
      word.text += "$" + m[0];
      word.vars.push(m[0]);
      return k + 1 + m[0].length;
    }
    if (nx && /[0-9@*#?$!-]/.test(nx)) {
      word.text += "$" + nx;
      word.vars.push(nx);
      return k + 2;
    }
    word.text += "$";
    return k + 1;
  };

  while (i < n) {
    const c = cmd[i];
    if (c === "\n") {
      endCmd("\n");
      i += 1;
      // Here-document bodies start on the next line.
      while (heredocs.length) i = readHeredoc(cmd, i, heredocs.shift());
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i += 1;
      continue;
    }
    if (c === "#" && !word) {
      const eol = cmd.indexOf("\n", i);
      i = eol === -1 ? n : eol;
      continue;
    }
    if (c === "\\") {
      if (cmd[i + 1] === "\n") {
        i += 2;
        continue;
      }
      newWord();
      word.text += cmd[i + 1] ?? "";
      word.quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close === -1) return { error: "an unbalanced single quote" };
      newWord();
      word.text += cmd.slice(i + 1, close);
      word.quoted = true;
      i = close + 1;
      continue;
    }
    if (c === "$" && cmd[i + 1] === "'") {
      // ANSI-C quoting: decode the escapes as bash does.
      let k = i + 2;
      while (k < n && cmd[k] !== "'") k += cmd[k] === "\\" ? 2 : 1;
      if (k >= n) return { error: "an unbalanced $'...' quote" };
      newWord();
      const { value, exact } = decodeEscapes(cmd.slice(i + 2, k), "js");
      word.text += value;
      word.quoted = true;
      if (!exact) word.dynamic = true;
      i = k + 1;
      continue;
    }
    if (c === '"' || (c === "$" && cmd[i + 1] === '"')) {
      newWord();
      word.quoted = true;
      let k = c === "$" ? i + 2 : i + 1;
      for (;;) {
        if (k >= n) return { error: "an unbalanced double quote" };
        const d = cmd[k];
        if (d === '"') break;
        if (d === "\\" && k + 1 < n && '$`"\\\n'.includes(cmd[k + 1])) {
          if (cmd[k + 1] !== "\n") word.text += cmd[k + 1];
          k += 2;
          continue;
        }
        if (d === "$") {
          k = expansion(k);
          continue;
        }
        if (d === "`") {
          const end = backtickEnd(cmd, k);
          if (end === -1) return { error: "an unbalanced backtick" };
          word.text += cmd.slice(k, end + 1);
          word.subst = true;
          substs.push(backtickBody(cmd.slice(k + 1, end), true));
          k = end + 1;
          continue;
        }
        word.text += d;
        k += 1;
      }
      i = k + 1;
      continue;
    }
    if (c === "$") {
      newWord();
      i = expansion(i);
      continue;
    }
    if (c === "`") {
      const end = backtickEnd(cmd, i);
      if (end === -1) return { error: "an unbalanced backtick" };
      newWord();
      word.text += cmd.slice(i, end + 1);
      word.subst = true;
      substs.push(backtickBody(cmd.slice(i + 1, end), false));
      i = end + 1;
      continue;
    }
    // Operators.
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "|&" || two === ";;") {
      endCmd(two);
      i += 2;
      continue;
    }
    if (c === "|" || c === ";" || c === "(" || c === ")") {
      endCmd(c);
      i += 1;
      continue;
    }
    if (c === "&" && cmd[i + 1] !== ">") {
      endCmd("&");
      i += 1;
      continue;
    }
    // Redirections: [n]< > >> << <<- <<< <> >& <& &> &>> >|
    if (c === "<" || c === ">" || (c === "&" && cmd[i + 1] === ">")) {
      let fd = null;
      if (word && /^[0-9]+$/.test(word.text) && !word.quoted) {
        fd = word.text;
        word = null; // an fd number
      } else endWord();
      const m = /^(?:<<<|<<-|<<|<>|<&|<|>>|>&|>\||>|&>>|&>)/.exec(cmd.slice(i, i + 3));
      const op = m[0];
      i += op.length;
      if ((op === "<" || op === ">") && cmd[i] === "(") {
        // Process substitution `<(cmd)` / `>(cmd)`: a command of its own, read below.
        newWord();
        const end = matchParen(cmd, i);
        word.text += op + cmd.slice(i, end);
        word.subst = true;
        substs.push(cmd.slice(i + 1, Math.max(i + 1, end - 1)));
        i = end;
        continue;
      }
      pendingRedir = { op, fd };
      continue;
    }
    newWord();
    word.text += c;
    i += 1;
  }
  endCmd("end");
  if (heredocs.length) {
    // bash runs a here-document that reaches the end of input; its body is what remains.
    for (const h of heredocs) h.body = h.body ?? "";
  }
  for (const c of cmds) for (const r of c.redirs) if (r.substs) substs.push(...r.substs);
  return { cmds, substs };
}

// A backtick substitution's command: `\\`, `` \` `` and `\$` lose their backslash (and `\"`
// inside double quotes).
function backtickBody(body, inDouble) {
  return body.replace(inDouble ? /\\([\\`$"])/g : /\\([\\`$])/g, "$1");
}

function backtickEnd(s, k) {
  for (let j = k + 1; j < s.length; j += 1) {
    if (s[j] === "\\") {
      j += 1;
      continue;
    }
    if (s[j] === "`") return j;
  }
  return -1;
}

// The index after the `)` matching the `(` at k (quote-aware, nested).
function matchParen(s, k) {
  let depth = 0;
  for (let j = k; j < s.length; j += 1) {
    const c = s[j];
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (c === "'") {
      const close = s.indexOf("'", j + 1);
      if (close === -1) return s.length;
      j = close;
      continue;
    }
    if (c === '"') {
      let q = j + 1;
      while (q < s.length && s[q] !== '"') q += s[q] === "\\" ? 2 : 1;
      j = q;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return s.length;
}

function matchBrace(s, k) {
  let depth = 0;
  for (let j = k; j < s.length; j += 1) {
    const c = s[j];
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return s.length;
}

// Read a here-document body from i; fill h.body / h.quoted / h.subst; return the index after it.
function readHeredoc(cmd, i, h) {
  const delimWord = h.word;
  const term = delimWord.text;
  h.quoted = delimWord.quoted;
  const strip = h.op === "<<-";
  let k = i;
  const lines = [];
  for (;;) {
    let eol = cmd.indexOf("\n", k);
    const last = eol === -1;
    if (last) eol = cmd.length;
    let line = cmd.slice(k, eol);
    if (strip) line = line.replace(/^\t+/, "");
    if (line === term) {
      k = last ? eol : eol + 1;
      break;
    }
    lines.push(line);
    if (last) {
      k = eol;
      h.unterminated = true;
      break;
    }
    k = eol + 1;
  }
  let body = lines.length ? lines.join("\n") + "\n" : "";
  h.vars = [];
  h.substs = [];
  h.subst = false;
  if (!h.quoted) {
    // An unquoted here-document expands `$...` and backticks; `\$`, `` \` ``, `\\` escape.
    let out = "";
    for (let j = 0; j < body.length; j += 1) {
      const c = body[j];
      if (c === "\\" && j + 1 < body.length && "$`\\\n".includes(body[j + 1])) {
        if (body[j + 1] !== "\n") out += body[j + 1];
        j += 1;
        continue;
      }
      if (c === "`" || (c === "$" && (body[j + 1] === "(" || body[j + 1] === "{"))) {
        if (c === "`" || body[j + 1] === "(" || !/^\$\{[A-Za-z_]\w*\}/.test(body.slice(j, j + 260)))
          h.subst = true;
        // The substitution runs when the here-document is expanded: keep its command.
        if (c === "`") {
          const end = backtickEnd(body, j);
          if (end !== -1) h.substs.push(backtickBody(body.slice(j + 1, end), false));
          else h.substs.push(body.slice(j + 1));
        } else if (body[j + 1] === "(") {
          const end = matchParen(body, j + 1);
          h.substs.push(body.slice(j + 2, Math.max(j + 2, end - 1)));
        } else {
          const end = matchBrace(body, j + 1);
          h.substs.push(body.slice(j + 2, Math.max(j + 2, end - 1)));
        }
      }
      if (c === "$") {
        const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*)|([0-9@*#?$!-]))/.exec(
          body.slice(j, j + 260),
        );
        if (m) h.vars.push(m[1] ?? m[2] ?? m[3]);
      }
      out += c;
    }
    body = out;
  }
  h.body = body;
  h.vars = [...new Set(h.vars)];
  return k;
}

// ---------------------------------------------------------------------
// FOLLOWING THE COMMAND TO ITS INTERPRETERS
// ---------------------------------------------------------------------

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/**
 * The inline programs of `cmd`: { programs: [{ lang, text, cwd, cwds, via }], reasons: [] }.
 * `cwds` is every directory the program may run in (cwd-flow.mjs; a null element: one
 * the hook cannot know), `cwd` the one directory when there is exactly one known, else
 * null.
 */
let LAST = { cmd: null, cwd: null, out: null };
function inlinePrograms(cmd, cwd = process.cwd()) {
  // The capability rule and the read rule ask for the same command: read it once.
  if (LAST.cmd === cmd && LAST.cwd === cwd) return LAST.out;
  const out = { programs: [], reasons: [] };
  walk(
    cmd,
    {
      cwds: [cwd],
      vars: new Map(),
      depth: 0,
      raw: cmd,
      sets: new Map(),
      fileVars: new Set(),
      out,
    },
    out,
  );
  LAST = { cmd, cwd, out };
  return out;
}

/** The one directory a program runs in, or null when it may run in several or one unknown. */
function oneCwd(ctx) {
  return ctx.cwds && ctx.cwds.length === 1 && ctx.cwds[0] !== null ? ctx.cwds[0] : null;
}

const OPEN_KEYWORDS = new Set(["if", "while", "until", "for", "select", "case", "{"]);
const LOOP_KEYWORDS = new Set(["while", "until", "for", "select"]);
const CLOSE_KEYWORDS = new Set(["fi", "done", "esac", "}"]);
const MID_KEYWORDS = new Set(["then", "do", "else", "elif", "time", "nohup"]);
const AND_OR_PIPE = new Set(["&&", "||", "|", "|&"]);

/**
 * THE DIRECTORY FLOW of one lexed command list (cwd-flow.mjs): for each simple command,
 * the separators around it, whether a `cd` in it can be relied on, and where the flow
 * becomes unknown. Linear in the number of commands.
 */
function dirPlan(cmds) {
  const n = cmds.length;
  const meta = new Array(n);
  const poisonAt = new Set();
  const frames = [];
  let fnPending = false;
  let anyCd = false;
  let broken = false;
  // The separator that ends each command's and-or list (a backgrounded list is scoped).
  const term = new Array(n);
  for (let k = n - 1; k >= 0; k -= 1) {
    term[k] = AND_OR_PIPE.has(cmds[k].op) && k + 1 < n ? term[k + 1] : cmds[k].op;
  }
  const kw = (w) =>
    w && !w.quoted && !w.subst && !w.dynamic && w.vars.length === 0 ? w.text : null;
  for (let k = 0; k < n; k += 1) {
    const words = cmds[k].words;
    let i = 0;
    let negate = false;
    let coproc = false;
    let header = false;
    for (;;) {
      const t = kw(words[i]);
      if (t === null) break;
      if (OPEN_KEYWORDS.has(t)) {
        const kind = t === "{" && fnPending ? "fn" : LOOP_KEYWORDS.has(t) ? "loop" : "block";
        if (fnPending && t !== "{") broken = true; // a body that is not `{ }`: not followed
        fnPending = false;
        frames.push({ kind, start: k, hasCd: false });
        i += 1;
        if (t === "for" || t === "select" || t === "case") {
          header = true; // the rest of the words are a list or a subject, not a command
          break;
        }
        continue;
      }
      if (CLOSE_KEYWORDS.has(t)) {
        const f = frames.pop();
        if (!f) broken = true;
        else if (f.hasCd && (f.kind === "loop" || f.kind === "fn")) {
          // A `cd` in a loop repeats; one in a function runs wherever it is called.
          poisonAt.add(f.start);
          for (const g of frames) g.hasCd = true;
        } else if (f.hasCd) for (const g of frames) g.hasCd = true;
        i += 1;
        continue;
      }
      if (MID_KEYWORDS.has(t)) {
        i += 1;
        continue;
      }
      if (t === "!") {
        negate = !negate;
        i += 1;
        continue;
      }
      if (t === "coproc") {
        coproc = true;
        i += 1;
        continue;
      }
      if (t === "function") {
        fnPending = true;
        header = true;
        break;
      }
      break;
    }
    if (cmds[k].fnHeader) {
      fnPending = true;
      header = true;
    }
    // Does this command change directory (or may it, through a body it runs later)?
    let j = i;
    while (j < words.length && ASSIGN.test(words[j].text)) j += 1;
    while (j < words.length && /^(?:command|builtin)$/.test(words[j].text)) j += 1;
    const verb = header ? null : basename(words[j]?.text ?? "");
    const changesDir = verb !== null && (CD_VERBS.has(verb) || verb === "source" || verb === ".");
    const laterBody =
      verb !== null &&
      (verb === "trap" || verb === "alias" || verb === "eval") &&
      words.slice(j + 1).some((w) => textMayChangeDir(w.text));
    if (changesDir || laterBody) {
      anyCd = true;
      for (const f of frames) f.hasCd = true;
    }
    meta[k] = {
      sep: cmds[k].sep,
      nextSep: cmds[k].op,
      scoped: frames.length > 0 || cmds[k].parenDepth > 0 || coproc || term[k] === "&",
      negate,
      fnBody: frames.some((f) => f.kind === "fn"),
      // A trap or an alias body that may change directory runs when the hook cannot see.
      unknownAfter: laterBody && verb !== "eval",
    };
  }
  if (frames.length || fnPending) broken = true;
  return { meta, poisonAt, anyCd, broken };
}

function walk(text, ctx, out) {
  if (ctx.depth > MAX_DEPTH) {
    // Unread, so refused: a quoted interpreter name hides from a word search here.
    if (/[A-Za-z]/.test(text)) {
      out.reasons.push("a command nested deeper than the hook reads (shells in shells)");
    }
    return;
  }
  const lexed = lexShell(text);
  if (lexed.error) {
    // Refused whenever it holds a word: bash runs every line before the one it cannot
    // parse (`n''ode -e ...` then `echo "$(x"` on the next line runs node), and a quoted
    // interpreter name hides from a word search. A text bash rejects whole runs nothing,
    // so the refusal costs nothing there.
    if (/[A-Za-z]/.test(text)) {
      out.reasons.push(`the command cannot be read as the shell will run it (${lexed.error})`);
    }
    return;
  }
  const { cmds, substs } = lexed;
  // Substitutions run in a subshell of their own: a `cd` or an assignment there does not
  // move the command around them.
  // Every one is read: a quoted name (`$(n''ode -e ...)`) hides from a word search.
  for (const body of substs) {
    if (!body) continue;
    walk(body, { ...ctx, vars: new Map(ctx.vars), depth: ctx.depth + 1 }, out);
  }
  // THE DIRECTORY FLOW: every command is read with every directory the shell may be in
  // when it runs (cwd-flow.mjs). A function body runs where it is called: while the
  // command changes directory anywhere, that is unknown. A structure the plan cannot
  // follow (an unclosed block, a stray `fi`, a function body that is not `{ }`) leaves
  // the directory unknown for a command that changes directory.
  const plan = dirPlan(cmds);
  ctx.anyCd = Boolean(ctx.anyCd) || plan.anyCd;
  const flow = new CwdFlow(ctx.cwds ?? [null]);
  if (plan.broken && plan.anyCd) flow.poison();
  for (let k = 0; k < cmds.length; k += 1) {
    const prev = k > 0 && (cmds[k - 1].op === "|" || cmds[k - 1].op === "|&") ? cmds[k - 1] : null;
    if (plan.poisonAt.has(k)) flow.poison();
    const m = plan.meta[k];
    if (m.fnBody) {
      // Not run here: read as it runs when called, and it does not move this flow.
      ctx.cwds = ctx.anyCd ? [null] : flow.input(";");
      simple(cmds[k], prev, ctx, out);
      continue;
    }
    const before = flow.input(m.sep);
    ctx.cwds = before;
    simple(cmds[k], prev, ctx, out);
    let after = ctx.cwds ?? [null];
    if (m.unknownAfter) after = cwdUnion(after, [null]);
    flow.step(m.sep, m.nextSep, before, after, { scoped: m.scoped, negate: m.negate });
  }
  flow.endList();
  // What follows this text (an eval's caller) starts wherever it may leave the shell.
  ctx.cwds = flow.outer;
}

function interpreterMentioned(text) {
  for (const m of text.matchAll(/[A-Za-z][\w.-]*/g)) {
    if (interpreterLang(m[0]) || otherInterpreterName(m[0])) return true;
  }
  return false;
}

// Fill in the variables the command assigned earlier; null when the word cannot be read.
function wordText(word, ctx) {
  let t = word.text;
  for (const v of word.vars) {
    if (ctx.vars.has(v) && ctx.vars.get(v) !== null) {
      t = t
        .split("${" + v + "}")
        .join(ctx.vars.get(v))
        .split("$" + v)
        .join(ctx.vars.get(v));
    }
  }
  return t;
}

// Why a program word cannot be read, or null.
function unreadableWhy(word, ctx) {
  if (word.subst) return "a program built by a command substitution";
  if (word.dynamic) return "a program in a quoting form the hook does not decode";
  for (const v of word.vars) {
    if (/^[0-9@*#?$!-]$/.test(v)) return `a program that takes text from the shell's $${v}`;
    if (ctx.vars.has(v) && ctx.vars.get(v) === null) {
      return `a program that takes text from $${v}, which the command sets at run time`;
    }
    if (!ctx.vars.has(v) && setsNameCached(ctx, v)) {
      return `a program that takes text from $${v}, which the command sets at run time`;
    }
  }
  return null;
}

function setsNameCached(ctx, v) {
  if (!ctx.sets.has(v)) ctx.sets.set(v, setsName(ctx.raw, v));
  return ctx.sets.get(v);
}

// Whether an interpreter's option-or-script word could carry a program the hook cannot
// see: a command substitution, the shell's positional parameters (`"$@"` in a function),
// or a variable the command sets at run time (`read`, a `for` over unseen words). An
// environment variable or a `for` over visible file names is taken as a script path.
function argUnseen(word, ctx) {
  if (word.subst || word.dynamic) return true;
  for (const v of word.vars) {
    if (/^[0-9@*#?$!-]$/.test(v)) return true;
    if (ctx.fileVars.has(v)) continue;
    if (ctx.vars.has(v) ? ctx.vars.get(v) === null : setsNameCached(ctx, v)) return true;
  }
  return false;
}

// Whether the command names `v` other than as an expansion (`read v`, `for v in`, `v=$(...)`).
function setsName(raw, v) {
  let from = 0;
  for (;;) {
    const at = raw.indexOf(v, from);
    if (at === -1) return false;
    from = at + v.length;
    const before = raw[at - 1] ?? "";
    const after = raw[at + v.length] ?? "";
    if (/[A-Za-z0-9_]/.test(after) || /[A-Za-z0-9_]/.test(before)) continue;
    if (before === "$" || (before === "{" && raw[at - 2] === "$")) continue;
    return true;
  }
}

function recordAssignments(words, ctx, start = 0) {
  let k = start;
  while (k < words.length) {
    const m = ASSIGN.exec(words[k].text);
    if (!m) break;
    const w = words[k];
    ctx.vars.set(m[1], w.subst || w.dynamic || w.vars.length ? null : m[2]);
    notePreload(ctx, w);
    k += 1;
  }
  return k;
}

// Environment variables that make an interpreter or a shell load or run code its
// program text does not show (a preload module, a startup file, a debugger, a library).
// They refuse an inline program (and a script) of an interpreter run directly; the
// value-checked ones in notePreload are judged by their value.
const PRELOAD_VARS = new Set([
  "PERL5OPT",
  "PERL5DB",
  "PERL_JSON_BACKEND",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "PYTHONSTARTUP",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "GCONV_PATH",
  "BASH_ENV",
]);
// Names an `export`, `read` or `printf -v` may not give a value the hook cannot see.
const PRELOAD_NAMES = new Set([
  ...PRELOAD_VARS,
  "ENV",
  "PERLIO",
  "RUBYOPT",
  "PYTHONBREAKPOINT",
  "PYTHONINSPECT",
  "PYTHONWARNINGS",
  "NODE_OPTIONS",
  "MAKEFLAGS",
  "GNUMAKEFLAGS",
  "MFLAGS",
  "MAKEFILES",
  "PS4",
  "GIT_SSH_COMMAND",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "EDITOR",
  "VISUAL",
  "GIT_EXTERNAL_DIFF",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
]);
// NODE_OPTIONS flags that load or expose code (most NODE_OPTIONS uses are memory limits).
const NODE_OPTIONS_LOADS =
  /(?:^|\s)(?:-r|--require|--import|--loader|--experimental-loader|--experimental-specifier-resolution|--inspect[\w-]*|-i|--interactive)(?:[=\s]|$)/;
// A NODE_OPTIONS module given as a URL (`--import=data:...`) or read from input: a program
// in the variable itself, whatever command starts node.
const NODE_OPTIONS_INLINE =
  /(?:^|\s)(?:-r|--require|--import|--loader|--experimental-loader)(?:=|\s+)["']?(?:(?!node:)[A-Za-z][\w+.-]*:|\/dev\/|\/proc\/)/;
// PERLIO layers that load no module of the agent's choosing.
const PERLIO_LAYER = "(?:raw|crlf|utf8|bytes|unix|perlio|stdio|pop|encoding\\([\\w.-]+\\))";
// One whitespace run between layers, so a long list cannot backtrack.
const PERLIO_SAFE = new RegExp(`^\\s*:?${PERLIO_LAYER}(?:\\s*:?${PERLIO_LAYER})*\\s*$`);
// Editors and pagers that run nothing but themselves; sed and awk scripts are read.
const EDITOR_SAFE =
  /^(?:true|false|:|cat|echo|vi|vim|nvim|nano|emacs|code(?: --wait| -w)?|subl(?: -w| --wait)?)$/;
const PAGER_SAFE = /^(?:|cat|less(?: -[A-Za-z~+]+)*|more)$/;
const GIT_PROGRAM_VARS = new Set([
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
]);

// Remember why an assignment word makes the interpreters after it unreadable, if it does
// (`ctx.preload`), and refuse at once a variable that runs code for any command that
// reads it (`npm test` starts node, `git commit` starts the editor).
function notePreload(ctx, w) {
  const m = ASSIGN.exec(w.text);
  if (!m) return;
  const name = m[1];
  const value = m[2];
  const unseen = w.subst || w.dynamic;
  const any = (why) => ctx.out?.reasons.push(`the command sets ${name}, ${why}`);
  if (name === "PERL5OPT" && (unseen || /(?:^|\s)-[A-Za-z]*[Mmd]/.test(value))) {
    // `-M'strict;system(...)'` is a program in the variable, for any perl it starts.
    any("which makes any perl the command starts load a module or run code");
  }
  if (PRELOAD_VARS.has(name)) {
    ctx.preload = `the command sets ${name}, which makes an interpreter load or run code the hook cannot see`;
  } else if (name === "ENV") {
    ctx.preloadShell = "the command sets ENV, which an interactive shell runs";
  } else if (name === "PERLIO") {
    if (unseen || w.vars.length || !PERLIO_SAFE.test(value))
      ctx.preload = "the command sets PERLIO to layers that may load a module";
  } else if (name === "RUBYOPT") {
    // -r and -I load libraries, -d and --debug run the debugger; -W0, --disable=gems pass.
    if (unseen || w.vars.length || /(?:^|\s)-(?:[A-Za-z]*[rIdx]|-(?:debug|require))/.test(value))
      ctx.preload = "the command sets RUBYOPT to load a library or run the debugger";
  } else if (name === "PYTHONBREAKPOINT") {
    if (value !== "0") ctx.preload = "the command sets PYTHONBREAKPOINT to a debugger hook";
  } else if (name === "PYTHONINSPECT") {
    any("which makes any python read a program from stdin when it ends");
  } else if (name === "PYTHONWARNINGS") {
    // A dotted warning category is imported (`ignore::pkg.Mod`): code the hook cannot see.
    if (unseen || value.split(",").some((f) => (f.split(":")[2] ?? "").includes(".")))
      any("whose warning category imports a module");
  } else if (name === "NODE_OPTIONS" || /^npm_config_node_options$/i.test(name)) {
    if (unseen || NODE_OPTIONS_INLINE.test(value)) {
      any("which carries a program for any node the command starts");
    } else if (NODE_OPTIONS_LOADS.test(value) || w.vars.some((v) => v !== "NODE_OPTIONS")) {
      ctx.preload = "the command sets NODE_OPTIONS to load code the hook cannot see";
    }
  } else if (/^(?:MAKEFLAGS|GNUMAKEFLAGS|MFLAGS)$/.test(name)) {
    // `MAKEFLAGS=--eval=...` and `MAKEFLAGS='X=$(shell ...)'` run make text; `-j8` passes.
    if (
      unseen ||
      w.vars.length ||
      value.includes("$") ||
      /!=|(?:^|\s)--(?:e|f|ma)|(?:^|\s)-[A-Za-z]*[Ef]/.test(value)
    ) {
      any("which makes make read or run text the hook cannot see");
    }
  } else if (name === "MAKEFILES") {
    if (unseen || /[$]|\/dev\/|\/proc\/|(?:^|\s)-(?:\s|$)/.test(value))
      any("which makes make read a makefile the hook cannot see");
  } else if (name === "PS4") {
    // Expanded before every traced command (`bash -x`, `set -x`, SHELLOPTS=xtrace).
    if (unseen || /\$\(|`/.test(value)) any("whose expansion runs a command when tracing is on");
  } else if (/^GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) {
    any("which configures git like `git -c` (refused for keys git runs as programs)");
  } else if (GIT_PROGRAM_VARS.has(name)) {
    if (unseen || !/^(?:|true|false|cat|echo)$/.test(value))
      any("a program git or ssh runs (put the setting in the repository's own tooling)");
  } else if (/^(?:GIT_EDITOR|GIT_SEQUENCE_EDITOR|EDITOR|VISUAL)$/.test(name)) {
    if (unseen) any("an editor command the hook cannot see");
    else if (/^(?:sed|gsed|awk|gawk)\s/.test(value)) {
      // `GIT_SEQUENCE_EDITOR="sed -i 's/pick/fixup/'"`: the script is read like any sed.
      walk(value, { ...ctx, depth: ctx.depth + 1 }, ctx.out);
    } else if (!EDITOR_SAFE.test(value.trim())) {
      any("an editor command git runs (use true, cat or a sed script)");
    }
  } else if (/^(?:PAGER|GIT_PAGER|MANPAGER|SYSTEMD_PAGER)$/.test(name)) {
    if (unseen || !PAGER_SAFE.test(value.trim())) any("a pager command (use cat or less)");
  } else if (/^LESS(?:OPEN|CLOSE)$/.test(name)) {
    any("a command less runs on every file");
  } else if (/(?:^|_)(?:JAVA_TOOL_OPTIONS|JAVA_OPTIONS|JDK_JAVA_OPTIONS|OPTS)$/.test(name)) {
    if (/-XX:\+?On(?:OutOfMemory)?Error/i.test(value)) any("a JVM option that runs a command");
  } else if (name === "PYTHONPYCACHEPREFIX" || name === "NODE_V8_COVERAGE") {
    // Both name a directory the runtime writes into.
    if (unseen) any("a directory the runtime writes into, which the hook cannot see");
    else if (value) {
      ctx.out?.programs.push({
        lang: "writes",
        paths: [value],
        cwd: oneCwd(ctx),
        cwds: ctx.cwds,
        via: name,
        what: `${name} (the runtime writes there)`,
      });
    }
  }
}

// The stdin of a simple command: { kind: "none" | "literal" | "file" | "unknown", texts }.
function stdinOf(c, prev, ctx) {
  // The last redirection of fd 0 wins (`prog < f.py <<< 'code'` reads the here-string).
  const stdinRedirs = c.redirs.filter(
    (r) =>
      /^(?:<<<|<<-|<<|<>|<&|<)$/.test(r.op) &&
      (r.fd === null || r.fd === undefined || r.fd === "0"),
  );
  for (const r of stdinRedirs.slice(-1)) {
    if (r.op === "<<" || r.op === "<<-") {
      if (r.subst) return { kind: "unknown", why: "a here-document with a command substitution" };
      const bad = (r.vars ?? []).find(
        (v) =>
          /^[0-9@*#?$!-]$/.test(v) ||
          ctx.vars.get(v) === null ||
          (!ctx.vars.has(v) && setsNameCached(ctx, v)),
      );
      if (bad) return { kind: "unknown", why: `a here-document that takes text from $${bad}` };
      return { kind: "literal", texts: [r.body ?? ""] };
    }
    if (r.op === "<<<") {
      const why = r.word && unreadableWhy(r.word, ctx);
      if (why) return { kind: "unknown", why };
      return { kind: "literal", texts: [wordText(r.word, ctx) + "\n"] };
    }
    if (r.op === "<" || r.op === "<>" || r.op === "<&") return { kind: "file" };
  }
  if (!prev) return { kind: "none" };
  // A pipe: read what the producer writes when it is a literal.
  const pw = prev.words;
  const eff = pw.length ? resolveEffectiveTokens(pw.map((w) => w.text)) : null;
  if (!eff) return { kind: "unknown", why: "a pipe from a command the hook cannot read" };
  const at = pw.length - eff.rest.length;
  const prog = basename(eff.verb);
  const args = pw.slice(at + 1);
  if (prog === "echo" || prog === "printf") {
    if (args.some((w) => unreadableWhy(w, ctx))) {
      return { kind: "unknown", why: "a pipe from echo or printf of text the hook cannot read" };
    }
    let words = args.map((w) => wordText(w, ctx));
    if (prog === "echo") while (words.length && /^-[neE]+$/.test(words[0])) words = words.slice(1);
    const joined = words.join(prog === "echo" ? " " : "\n");
    // Escapes are decoded by printf, by `echo -e` and by some shells' echo: read both.
    return { kind: "literal", texts: [joined, decodeEscapes(joined, "js").value] };
  }
  if (prog === "cat") {
    const files = args.filter((w) => !/^-/.test(w.text));
    const lit = stdinOf(prev, null, ctx);
    if (files.length === 0) return lit.kind === "none" ? { kind: "none" } : lit;
    if (files.every((w) => !w.subst && !w.vars.length && w.text !== "-")) return { kind: "file" };
  }
  return {
    kind: "unknown",
    why: `a pipe from ${prog || "a command"}, whose output the hook cannot read`,
  };
}

function simple(c, prev, ctx, out, feed = null) {
  let words = c.words;
  if (words.length === 0) return;
  // Leading assignments. A bare `X=1` sets X for the commands after it; in `X=1 prog "$X"`
  // the word is expanded before the assignment, and X is not set afterwards, so the hook
  // treats such a name as unknown from here on.
  let firstNonAssign = 0;
  while (firstNonAssign < words.length && ASSIGN.test(words[firstNonAssign].text))
    firstNonAssign += 1;
  if (firstNonAssign >= words.length) {
    recordAssignments(words, ctx);
    return;
  }
  for (const w of words.slice(0, firstNonAssign)) {
    ctx.vars.set(ASSIGN.exec(w.text)[1], null);
    notePreload(ctx, w);
  }
  const w0 = words[firstNonAssign].text;
  // `read NODE_OPTIONS; export NODE_OPTIONS`, `printf -v PERL5OPT ...`: a preload variable
  // given a value the hook does not see.
  if (
    /^(?:export|declare|local|readonly|typeset|read|mapfile|readarray|printf)$/.test(w0) &&
    words.slice(firstNonAssign + 1).some((w) => PRELOAD_NAMES.has(w.text))
  ) {
    ctx.preload = `the command gives a preload variable a value the hook cannot see (${w0})`;
  }
  if (["export", "declare", "local", "readonly", "typeset"].includes(w0)) {
    let k = firstNonAssign + 1;
    while (k < words.length && words[k].text.startsWith("-")) k += 1;
    recordAssignments(words, ctx, k);
    return;
  }
  if (w0 === "read" || w0 === "mapfile" || w0 === "readarray" || w0 === "getopts") {
    // `mapfile -C 'cmd'` runs its callback as a command.
    for (let k = firstNonAssign + 1; k < words.length; k += 1) {
      const t = words[k].text;
      const cb = t === "-C" ? wordText(words[k + 1] ?? { text: "", vars: [] }, ctx) : null;
      const glued = /^-C(.+)$/s.exec(t);
      const body = cb ?? (glued ? glued[1] : null);
      if (body) walk(body, { ...ctx, depth: ctx.depth + 1 }, out);
    }
    for (const w of words.slice(firstNonAssign + 1)) {
      if (/^[A-Za-z_]\w*$/.test(w.text)) ctx.vars.set(w.text, null);
    }
    return;
  }
  if (w0 === "for" || w0 === "select") {
    const name = words[firstNonAssign + 1]?.text;
    if (name && /^[A-Za-z_]\w*$/.test(name)) {
      ctx.vars.set(name, null);
      // `for f in test/*.js`: every value is a visible word that is not an option.
      const list = words.slice(firstNonAssign + 3);
      const plain = w0 === "for" && words[firstNonAssign + 2]?.text === "in";
      if (
        plain &&
        list.every((w) => !w.subst && !w.dynamic && !w.vars.length && !w.text.startsWith("-"))
      ) {
        ctx.fileVars.add(name);
      } else ctx.fileVars.delete(name);
    }
    return;
  }
  inspectWords(words.slice(firstNonAssign), c, prev, ctx, out, feed);
}

// Follow one command's words to the program that runs; record inline programs.
function inspectWords(words, c, prev, ctx, out, feed, guard = 0) {
  if (words.length === 0) return;
  if (guard > 24) {
    // Past this many wrappers and keywords the command is not followed: refused when any
    // word left (quotes already removed, so `n''ode` reads as node) could run a program
    // (`env env ... node -e ...`); `env -i env -i ... echo hi` stays allowed.
    const runs = words.some((w) => {
      const b = basename(w.text);
      return (
        interpreterLang(w.text) ||
        otherInterpreterName(w.text) ||
        SHELLS.has(b) ||
        /^(?:busybox|eval|trap|alias|source|\.)$/.test(b) ||
        /\s/.test(w.text) ||
        w.subst ||
        w.dynamic ||
        w.vars.length > 0
      );
    });
    if (runs) out.reasons.push("a command behind more wrappers and keywords than the hook reads");
    return;
  }
  const texts = words.map((w) => wordText(w, ctx));
  let first = basename(texts[0]);
  if (
    (words[0].subst || /[$`]/.test(texts[0])) &&
    texts.some((x, i) => i > 0 && /^-(?:c|e|E|r|p|pe|ne|-eval|-print)$|^--(?:eval|print)=/.test(x))
  ) {
    out.reasons.push(
      `a program run by a command whose name the hook cannot see (${texts[0].slice(0, 40)})`,
    );
    return;
  }
  // Keywords and groups in front of a command.
  if (
    [
      "{",
      "}",
      "!",
      "do",
      "then",
      "else",
      "elif",
      "if",
      "while",
      "until",
      "time",
      "exec",
      "coproc",
      "nohup",
      "case",
      "esac",
      "done",
      "fi",
    ].includes(texts[0])
  ) {
    return inspectWords(words.slice(1), c, prev, ctx, out, feed, guard + 1);
  }
  if (first === "trap") {
    // `trap 'cmd' EXIT`: the shell runs the first argument as a command.
    let k = 1;
    while (k < texts.length && /^-[lp-]*$/.test(texts[k]) && texts[k] !== "-") k += 1;
    if (texts[k] !== undefined) {
      const why = unreadableWhy(words[k], ctx);
      if (why) out.reasons.push(`${why} (trap)`);
      // It runs when the signal comes: wherever the shell is then, unknown once the
      // command changes directory.
      walk(texts[k], { ...ctx, depth: ctx.depth + 1, cwds: ctx.anyCd ? [null] : ctx.cwds }, out);
    }
    return;
  }
  if (first === "alias") {
    // An alias runs its value where it is used (with expand_aliases on).
    for (let k = 1; k < texts.length; k += 1) {
      const m = /^[^=]+=(.*)$/s.exec(texts[k]);
      if (m) {
        walk(m[1], { ...ctx, depth: ctx.depth + 1, cwds: ctx.anyCd ? [null] : ctx.cwds }, out);
      }
    }
    return;
  }
  if (first === "cd" || first === "pushd" || first === "popd") {
    const arg = texts.slice(1).find((t) => !/^-[LPe@]+$/.test(t));
    const relative = arg !== undefined && !arg.startsWith("/") && !arg.startsWith("~");
    ctx.cds = (ctx.cds ?? 0) + 1;
    if (
      first !== "cd" ||
      ctx.cwds === null ||
      ctx.cds > 32 || // past this many, the directory is unknown (bounded work)
      (relative && (process.env.CDPATH || /CDPATH/.test(ctx.raw)))
    ) {
      ctx.cwds = [null]; // the directory stack and CDPATH are unknown to a stateless hook
    } else {
      // From every directory the shell may be in (the flow decides what that replaces).
      const next = [];
      for (const from of ctx.cwds) {
        let to;
        try {
          to = from === null && relative ? null : replayCd({ verb: "cd", rest: texts }, from);
        } catch {
          to = null; // a path too deep to resolve: unknown
        }
        if (!next.includes(to)) next.push(to);
      }
      ctx.cwds = cwdUnion(next);
    }
    return;
  }
  if (first === "env") {
    // `env -S "prog args"` splits its string into words; `env -C dir` changes directory.
    let k = 1;
    while (k < words.length) {
      const t = texts[k];
      if (t === "-S" || t === "--split-string") {
        const rest = texts.slice(k + 2).join(" ");
        return walk(`${texts[k + 1] ?? ""} ${rest}`, { ...ctx, depth: ctx.depth + 1 }, out);
      }
      if (/^-S./.test(t) || t.startsWith("--split-string=")) {
        const val = t.startsWith("-S") ? t.slice(2) : t.slice("--split-string=".length);
        return walk(
          `${val} ${texts.slice(k + 1).join(" ")}`,
          { ...ctx, depth: ctx.depth + 1 },
          out,
        );
      }
      if (t === "-C" || t === "--chdir" || /^-C./.test(t) || t.startsWith("--chdir="))
        ctx.cwds = [null];
      if (t === "-u" || t === "--unset" || t === "-C" || t === "--chdir") {
        k += 2;
        continue;
      }
      if (ASSIGN.test(t)) notePreload(ctx, words[k]);
      if (t.startsWith("-") || ASSIGN.test(t)) {
        k += 1;
        continue;
      }
      break;
    }
    return inspectWords(words.slice(k), c, prev, ctx, out, feed, guard + 1);
  }
  // Assignments, wrappers and package runners (the same peeling the other rules use).
  const eff = resolveEffectiveTokens(texts);
  if (!eff) return;
  if (eff.rest.length !== texts.length) {
    return inspectWords(
      words.slice(texts.length - eff.rest.length),
      c,
      prev,
      ctx,
      out,
      feed,
      guard + 1,
    );
  }
  first = basename(texts[0]);
  if (first === "busybox" && texts.length > 1 && !SHELLS.has(texts[1])) {
    // `busybox awk ...`, `busybox sed ...`: the applet is the command.
    return inspectWords(words.slice(1), c, prev, ctx, out, feed, guard + 1);
  }
  const lang = interpreterLang(texts[0]);
  if (
    (lang || otherInterpreterName(texts[0]) || SHELLS.has(first)) &&
    texts.slice(1).some((t) => FD_PATH.test(t))
  ) {
    // `python3 /dev/fd/3 3<<'EOF'`, `awk -f /dev/fd/3`: a program on a file descriptor.
    out.reasons.push(`${first} reads a program from a file descriptor the hook cannot read`);
    return;
  }
  if (lang) return interpreter(lang, words, c, prev, ctx, out, feed);
  if (otherInterpreterName(texts[0])) {
    // awk, sed, sqlite3, lua, R, ...: lib/hook/inline-other.mjs.
    // `make -j$(nproc)`: a job count from the processor count is not a program.
    const jobs = (w) =>
      (first === "make" || first === "gmake") &&
      /^-j\$\((?:nproc|getconf _NPROCESSORS_ONLN|sysctl -n hw\.(?:ncpu|logicalcpu))\)$/.test(
        w.text,
      );
    const unseen = words.slice(1).find((w) => argUnseen(w, ctx) && !jobs(w));
    if (unseen || (feed?.placeholder && texts.some((t) => t.includes(feed.placeholder)))) {
      out.reasons.push(`${first} is given a program the hook cannot see`);
      return;
    }
    if (feed?.appends && /^(?:awk|gawk|mawk|nawk|sed|gsed|sqlite3)$/.test(first) === false) {
      out.reasons.push(`${first} run by xargs or parallel (its program could arrive from input)`);
      return;
    }
    if (ctx.preload) out.reasons.push(ctx.preload);
    // make judges a `$` in an assignment as its own expansion: a shell variable (expanded
    // before make runs, like any environment value) is not one.
    const given =
      first === "make" || first === "gmake"
        ? words.map((w) => {
            let t = wordText(w, ctx);
            for (const v of w.vars)
              t = t
                .split("${" + v + "}")
                .join("_")
                .split("$" + v)
                .join("_");
            return t;
          })
        : texts;
    otherInterpreter(given, oneCwd(ctx), out, () => stdinOf(c, prev, ctx));
    return;
  }
  if (SHELLS.has(first) || (first === "busybox" && SHELLS.has(texts[1] ?? ""))) {
    const ws = first === "busybox" ? words.slice(1) : words;
    if (ctx.preload && /BASH_ENV|LD_|DYLD_|GCONV/.test(ctx.preload)) out.reasons.push(ctx.preload);
    if (ctx.preloadShell && ws.some((w, idx) => idx > 0 && /^-[A-Za-z]*i/.test(w.text)))
      out.reasons.push(ctx.preloadShell);
    const ci = ws.findIndex((w, idx) => idx > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text));
    if (ci !== -1) {
      const body = ws[ci + 1];
      if (!body) return;
      if (
        feed?.placeholder &&
        body.text.includes(feed.placeholder) &&
        interpreterMentioned(body.text)
      ) {
        out.reasons.push("a shell program filled in by xargs, parallel or find from their input");
      }
      // A body the hook cannot read is a program it cannot see, whatever words it shows
      // (`X=$(printf ...); sh -c "$X"`).
      const why = unreadableWhy(body, ctx);
      if (why) out.reasons.push(`${why} (${first} -c)`);
      return walk(wordText(body, ctx), { ...ctx, depth: ctx.depth + 1 }, out);
    }
    const script = ws.slice(1).find((w) => !w.text.startsWith("-"));
    if (!script || script.text === "-" || script.text === "/dev/stdin") {
      const sin = stdinOf(c, prev, ctx);
      if (sin.kind === "literal") {
        for (const t of sin.texts) walk(t, { ...ctx, depth: ctx.depth + 1 }, out);
      }
    }
    return;
  }
  if (first === "eval") {
    const why = words
      .slice(1)
      .map((w) => unreadableWhy(w, ctx))
      .find(Boolean);
    const body = words
      .slice(1)
      .map((w) => wordText(w, ctx))
      .join(" ");
    // `eval "$(direnv export bash)"`, `eval "$(pyenv init -)"`: a tool's output is run as
    // a program everywhere; refused only when the words show an interpreter.
    if (why && interpreterMentioned(body)) out.reasons.push(why);
    // eval runs in the current shell: a `cd` in it moves the commands after it.
    ctx.depth += 1;
    walk(body, ctx, out);
    ctx.depth -= 1;
    return;
  }
  if (first === "source" || first === ".") {
    ctx.cwds = [null]; // a sourced file can change directory
    return;
  }
  if (first === "xargs") {
    const { at, replace } = xargsSplit(texts);
    return inspectWords(
      words.slice(at),
      c,
      null,
      ctx,
      out,
      { placeholder: replace, appends: !replace },
      guard + 1,
    );
  }
  if (first === "parallel") {
    let k = 1;
    let placeholder = null;
    while (k < texts.length && texts[k].startsWith("-")) {
      const m = /^(?:-I(.+)|--replace=(.+))$/.exec(texts[k]);
      if (m) placeholder = m[1] || m[2];
      else if (texts[k] === "-I") placeholder = texts[k + 1];
      k += PARALLEL_VALUE.has(texts[k]) ? 2 : 1;
    }
    let end = texts.findIndex((x, idx) => idx >= k && /^:{3,4}\+?$/.test(x));
    if (end === -1) end = texts.length;
    const inner = words.slice(k, end);
    if (inner.length === 1 && /\s/.test(inner[0].text)) {
      return walk(inner[0].text, { ...ctx, depth: ctx.depth + 1 }, out);
    }
    return inspectWords(
      inner,
      c,
      null,
      ctx,
      out,
      { placeholder: placeholder ?? "{", appends: true },
      guard + 1,
    );
  }
  if (first === "find") {
    for (let k = 1; k < texts.length; k += 1) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(texts[k])) continue;
      let end = k + 1;
      while (end < texts.length && !/^(?:;|\+)$/.test(texts[end])) end += 1;
      inspectWords(
        words.slice(k + 1, end),
        c,
        null,
        ctx,
        out,
        { placeholder: "{}", appends: false },
        guard + 1,
      );
      k = end;
    }
    return;
  }
  if (first === "fd" || first === "fdfind") {
    const k = texts.findIndex((x, idx) => idx > 0 && /^(?:-x|--exec|-X|--exec-batch)$/.test(x));
    if (k === -1) return;
    let end = k + 1;
    while (end < texts.length && texts[end] !== ";") end += 1;
    return inspectWords(
      words.slice(k + 1, end),
      c,
      null,
      ctx,
      out,
      { placeholder: "{", appends: true },
      guard + 1,
    );
  }
  if (DATA_PROGRAMS.has(first)) return;
  // Any other program: a runner (`watch`, `flock lock`, `strace -f`, `uv run`, `ssh host`,
  // `script -c "..."`) runs the interpreter or the shell string among its words.
  for (let k = 1; k < words.length; k += 1) {
    const t = texts[k];
    if (/\s/.test(t) && interpreterMentioned(t)) {
      walk(t, { ...ctx, depth: ctx.depth + 1 }, out);
      continue;
    }
    const b = basename(t);
    if (
      interpreterLang(t) ||
      SHELLS.has(b) ||
      ["xargs", "parallel", "find", "env", "eval"].includes(b)
    ) {
      return inspectWords(words.slice(k), c, prev, ctx, out, feed, guard + 1);
    }
  }
}

const XARGS_VALUE = new Set([
  "-a",
  "--arg-file",
  "-d",
  "--delimiter",
  "-E",
  "-e",
  "-L",
  "-l",
  "-n",
  "--max-args",
  "-P",
  "--max-procs",
  "-s",
  "--max-chars",
  "--process-slot-var",
  "-R",
  "-S",
]);
function xargsSplit(texts) {
  let k = 1;
  let replace = null;
  while (k < texts.length && texts[k].startsWith("-") && texts[k] !== "--") {
    const w = texts[k];
    let m;
    if ((m = /^-[0prtx]*[IJ](.*)$/.exec(w))) {
      if (m[1]) {
        replace = m[1];
        k += 1;
      } else {
        replace = texts[k + 1] ?? "";
        k += 2;
      }
      continue;
    }
    if ((m = /^-[0prtx]*i(.*)$/.exec(w))) {
      replace = m[1] || "{}";
      k += 1;
      continue;
    }
    if ((m = /^--replace(?:=(.*))?$/.exec(w))) {
      replace = m[1] || "{}";
      k += 1;
      continue;
    }
    k += XARGS_VALUE.has(w) ? 2 : 1;
  }
  if (texts[k] === "--") k += 1;
  return { at: k, replace };
}

const PARALLEL_VALUE = new Set([
  "-j",
  "--jobs",
  "-N",
  "-n",
  "--max-args",
  "-S",
  "--sshlogin",
  "-I",
  "--colsep",
  "-C",
  "-d",
  "--delimiter",
  "-a",
  "--arg-file",
  "--delay",
  "--timeout",
  "--joblog",
  "--results",
  "--tmpdir",
  "-E",
  "--env",
  "--tag-string",
  "--rpl",
  "--sshloginfile",
  "--workdir",
  "--wd",
]);

// ---------------------------------------------------------------------
// INTERPRETER OPTIONS
// ---------------------------------------------------------------------

// Option letters that take a value (glued or as the next word), per interpreter.
const VALUE_LETTERS = {
  python: new Set(["W", "X", "Q"]),
  ruby: new Set(["r", "I", "C", "E", "F", "i", "x"]),
  perl: new Set(["M", "m", "I", "i", "F", "d", "D", "x"]),
};
// Letters that take optional glued digits and may be followed by more letters.
const DIGIT_LETTERS = { ruby: new Set(["0", "T"]), perl: new Set(["0", "l", "C"]) };

// php -d settings that cannot load code or write files (auto_prepend_file, error_log,
// extension, include_path, sendmail_path and the rest are refused).
const PHP_SAFE_INI = new Set(
  (
    "display_errors display_startup_errors error_reporting memory_limit max_execution_time " +
    "max_input_time date.timezone html_errors precision serialize_precision short_open_tag " +
    "default_charset log_errors zend.assertions assert.active assert.exception output_buffering " +
    "implicit_flush default_socket_timeout report_memleaks variables_order register_argc_argv " +
    "intl.default_locale mbstring.language mbstring.internal_encoding pcre.jit " +
    "pcre.backtrack_limit pcre.recursion_limit zend.enable_gc opcache.enable opcache.enable_cli"
  ).split(" "),
);

// The Python standard library's top-level modules (3.11 to 3.14). `python -m` of one of
// these runs a command line the hook can read; any other module is a package or a local
// file, as invisible as a script (the documented residual).
const PY_STDLIB = new Set(
  (
    "abc aifc annotationlib antigravity argparse array ast asynchat asyncio asyncore atexit " +
    "audioop base64 bdb binascii bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath " +
    "cmd code codecs codeop collections colorsys compileall compression concurrent " +
    "configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses " +
    "datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno " +
    "faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath " +
    "getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib " +
    "imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 " +
    "linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder " +
    "msilib msvcrt multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode " +
    "operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform " +
    "plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc " +
    "pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy " +
    "sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr " +
    "socket socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics " +
    "string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile " +
    "telnetlib tempfile termios textwrap this threading time timeit tkinter token tokenize " +
    "tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata " +
    "unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref " +
    "xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo"
  ).split(" "),
);
// Standard-library command lines that only read and print, or run files the agent wrote
// (unittest, doctest: the residual), or are judged by the install rules (pip).
const PY_M_READ_ONLY = new Set(
  (
    "unittest doctest tokenize ast dis base64 calendar platform sysconfig site uuid tabnanny " +
    "pyclbr symtable mimetypes filecmp this quopri pip"
  ).split(" "),
);

/**
 * `python -m MODULE ARGS`: a standard-library module's command line is read here. Its
 * code arguments (`-m timeit`) are inline programs, its output paths (`-m json.tool IN
 * OUT`, `-m venv DIR`, `-m cProfile -o FILE`) are writes judged against the write roots,
 * and a command line that can write, run code or reach the network otherwise is refused.
 */
function pythonModule(mod, argv, argWords, cwd, ctx, out, name) {
  const top = mod.split(".")[0];
  if (!PY_STDLIB.has(top)) return;
  const via = `${name} -m ${mod}`;
  if (argWords.some((w) => argUnseen(w, ctx))) {
    out.reasons.push(`${via} is given arguments the hook cannot see`);
    return;
  }
  const writes = (paths, what) => {
    if (paths.length) out.programs.push({ lang: "writes", paths, cwd, via, what });
  };
  // Split ARGS into options (with the given value-taking ones) and positionals.
  const split = (valued) => {
    const opts = [];
    const pos = [];
    for (let k = 0; k < argv.length; k += 1) {
      const a = argv[k];
      if (a === "--") {
        pos.push(...argv.slice(k + 1));
        break;
      }
      if (a.startsWith("-") && a !== "-") {
        const eq = a.indexOf("=");
        const flag = eq === -1 ? a : a.slice(0, eq);
        if (valued.has(flag) && eq === -1) {
          opts.push([flag, argv[k + 1] ?? ""]);
          k += 1;
        } else if (/^-[a-zA-Z]./.test(a) && valued.has(a.slice(0, 2))) {
          opts.push([a.slice(0, 2), a.slice(2)]);
        } else opts.push([flag, eq === -1 ? null : a.slice(eq + 1)]);
      } else pos.push(a);
    }
    return { opts, pos };
  };
  if (mod === "timeit") {
    const { opts, pos } = split(
      new Set(["-n", "--number", "-r", "--repeat", "-s", "--setup", "-u", "--unit"]),
    );
    const code = opts.filter(([f]) => f === "-s" || f === "--setup").map(([, v]) => v ?? "");
    if (pos.length) code.push(pos.join("\n"));
    for (const text of code) out.programs.push({ lang: "python", text, cwd, via, preload: [] });
    return;
  }
  if (mod === "json.tool" || mod === "json") {
    const { pos } = split(new Set(["--indent"]));
    writes(
      pos.slice(1, 2).filter((p) => p !== "-"),
      "json.tool",
    );
    return;
  }
  if (mod === "venv") {
    const { pos } = split(new Set(["--prompt"]));
    writes(pos, "venv");
    return;
  }
  if (mod === "cProfile" || mod === "profile") {
    // Runs a script or module (the residual); `-o FILE` writes the profile.
    const { opts } = split(new Set(["-o", "--outfile", "-s", "--sort", "-m"]));
    writes(
      opts.filter(([f]) => f === "-o" || f === "--outfile").map(([, v]) => v ?? ""),
      "cProfile -o",
    );
    return;
  }
  if (mod === "compileall") {
    // Writes `__pycache__` beside every source under the named directories (sys.path
    // when none is named); `-i FILE` takes the list from a file or stdin. It follows
    // symlinked directories when it recurses, so only `-l` (no recursion) is judged.
    const { opts, pos } = split(
      new Set(["-d", "-s", "-p", "-x", "-i", "-r", "-j", "-o", "-e", "--invalidation-mode"]),
    );
    if (opts.some(([f]) => f === "-i") || pos.length === 0 || !opts.some(([f]) => f === "-l")) {
      out.reasons.push(
        `${via} recurses into directories the hook cannot see (use compileall -l DIR, or py_compile FILE)`,
      );
      return;
    }
    writes(pos, "compileall");
    return;
  }
  if (mod === "py_compile") {
    // Writes `__pycache__` beside each named file; `-` reads the names from stdin.
    const { pos } = split(new Set());
    if (pos.length === 0 || pos.includes("-")) {
      out.reasons.push(`${via} reads the files to compile from stdin`);
      return;
    }
    writes(pos, "py_compile");
    return;
  }
  if (mod === "zipfile" || mod === "tarfile") {
    // -l / -t only read the archive; -c writes it; -e extracts (zipfile keeps members
    // under the target; a tar member may name any path, so tarfile -e is refused).
    const { opts, pos } = split(
      new Set(["-l", "--list", "-t", "--test", "-e", "--extract", "-c", "--create", "--filter"]),
    );
    const flag = (names) => opts.find(([f]) => names.includes(f));
    if (flag(["-c", "--create"])) {
      const [, archive] = flag(["-c", "--create"]);
      writes([archive ?? ""], `${mod} -c`);
      return;
    }
    if (flag(["-e", "--extract"])) {
      if (mod === "tarfile") {
        out.reasons.push(`${via} -e extracts members that may name any path`);
        return;
      }
      writes([pos[0] ?? "."], "zipfile -e");
      return;
    }
    if (flag(["-l", "--list", "-t", "--test"])) return;
    out.reasons.push(`${via} is given a command line the hook does not read`);
    return;
  }
  if (mod === "trace") {
    // Tracing and listing print; counting writes `.cover` files beside every module run.
    const PRINT_ONLY = new Set([
      "-t",
      "--trace",
      "-l",
      "--listfuncs",
      "-T",
      "--trackcalls",
      "-g",
      "--timing",
      "--ignore-module",
      "--ignore-dir",
      "--module",
    ]);
    const { opts } = split(new Set(["--ignore-module", "--ignore-dir"]));
    const bad = opts.find(([f]) => !PRINT_ONLY.has(f));
    if (bad || opts.length === 0) {
      out.reasons.push(`${via} ${bad ? bad[0] : ""} writes coverage files (use -t, -l or -T)`);
    }
    return;
  }
  if (mod === "http.server") {
    // A preview server is fine on the loopback interface, serving the worktree; any
    // other interface publishes the files, `--cgi` runs programs, and a directory outside
    // the worktree serves what the read rules keep from the agent.
    const { opts } = split(new Set(["-b", "--bind", "-d", "--directory", "-p", "--protocol"]));
    const bind = opts.find(([f]) => f === "-b" || f === "--bind")?.[1] ?? "";
    const dir = opts.find(([f]) => f === "-d" || f === "--directory")?.[1] ?? "";
    if (
      !/^(?:127\.0\.0\.1|localhost|::1)$/.test(bind) ||
      opts.some(([f]) => f === "--cgi") ||
      dir.startsWith("/") ||
      dir.startsWith("~") ||
      dir.split("/").includes("..")
    ) {
      out.reasons.push(
        `${via} serves files beyond the worktree's loopback preview (run python3 -m http.server --bind 127.0.0.1 from the worktree)`,
      );
    }
    return;
  }
  if (mod === "pydoc") {
    // `pydoc NAME` and `pydoc -k WORD` print; -p and -b start a server (and a browser).
    const { opts } = split(new Set(["-k", "-p", "-n"]));
    if (opts.some(([f]) => f === "-p" || f === "-b" || f === "-n")) {
      out.reasons.push(`${via} starts a documentation server: read the docs with pydoc NAME`);
      return;
    }
    // `-w` writes NAME.html for a module or for every module under a directory.
    if (opts.some(([f]) => f === "-w"))
      out.reasons.push(`${via} -w writes files the hook cannot name`);
    return;
  }
  if (PY_M_READ_ONLY.has(mod) || PY_M_READ_ONLY.has(top)) return;
  out.reasons.push(
    `${via} runs a standard-library command line that can write files, run code or reach the network`,
  );
}

/**
 * Find the inline programs of one interpreter invocation (`words` start at the
 * interpreter) and record them, or a reason when the program cannot be seen.
 */
function interpreter(lang, words, c, prev, ctx, out, feed) {
  if (ctx.preload) out.reasons.push(ctx.preload);
  const texts = words.map((w) => wordText(w, ctx));
  const programs = []; // words (or { text }) that hold program text
  let script = null; // the first operand: a script file (or the end of the options)
  let cwd = oneCwd(ctx);
  let cwds = ctx.cwds;
  let sawModule = false;
  const preload = []; // ruby -r LIB, perl -M MODULE
  let perlSplit = null; // perl -F PATTERN
  const progLang = lang === "deno" ? "js" : lang;
  const name = basename(texts[0]);
  let k = 1;
  if (lang === "deno") {
    // Global flags may come before the subcommand (`deno -A eval ...`).
    let s0 = 1;
    while (s0 < texts.length && texts[s0].startsWith("-") && texts[s0] !== "-") {
      s0 += /^(?:-L|--log-level)$/.test(texts[s0]) ? 2 : 1;
    }
    words = [words[0], ...words.slice(s0)];
    texts.splice(1, s0 - 1);
    const sub = texts[1];
    if (sub === "eval") {
      k = 2;
      while (k < texts.length && texts[k].startsWith("-")) {
        k +=
          /^(?:--ext|-c|--config|--cert|--location|--seed|--import-map|--env-file|--v8-flags)$/.test(
            texts[k],
          )
            ? 2
            : 1;
      }
      if (words[k]) programs.push(words[k]);
    } else if (sub === "repl") {
      for (let j = 2; j < texts.length; j += 1) {
        if (texts[j] === "--eval") programs.push(words[j + 1] ?? { text: "" });
        else if (texts[j].startsWith("--eval="))
          programs.push({ ...words[j], text: texts[j].slice(7) });
      }
    } else if (sub === "run" || sub === undefined) {
      k = sub ? 2 : 1;
      while (k < texts.length && texts[k].startsWith("-") && texts[k] !== "-") k += 1;
      script = texts[k] ?? null;
      if (script === "-") script = null;
      else if (script === null && sub) script = "";
      if (script && /^[A-Za-z][\w+.-]*:/.test(script)) {
        // `deno run data:...` or `https://...`: a program in the URL or fetched from the network.
        out.reasons.push(`deno runs a program from a URL (${script.slice(0, 40)})`);
        return;
      }
    } else {
      script = sub; // deno task / test / x / install: files and packages, not inline text
    }
  } else {
    if (name === "bun" && texts[1] === "repl") {
      out.reasons.push("bun repl reads its program from stdin");
      return;
    }
    if (name === "bun" && texts[1] === "exec") {
      // `bun exec "script"` runs a shell script with Bun's shell.
      const why = words[2] && unreadableWhy(words[2], ctx);
      if (why) out.reasons.push(`${why} (bun exec)`);
      if (texts[2]) walk(texts[2], { ...ctx, depth: ctx.depth + 1 }, out);
      return;
    }
    while (k < texts.length) {
      const t = texts[k];
      if (argUnseen(words[k], ctx)) {
        // `python3 "$@"`, `node $(cat args)`: an option or the script could be a program flag.
        out.reasons.push(
          `${name} is given arguments the hook cannot see (${t.slice(0, 40)}), so its program could be inline`,
        );
        return;
      }
      if (t === "--") {
        k += 1;
        script = texts[k] ?? null;
        break;
      }
      if (t === "-" || !t.startsWith("-")) {
        script = t === "-" ? null : t;
        if (t === "-") script = "-";
        break;
      }
      if (lang === "js") {
        // node / bun options.
        const m = /^--(eval|print)=(.*)$/s.exec(t);
        if (/^(?:-i|--interactive|--inspect[\w-]*(?:=.*)?|--experimental-repl-await)$/s.test(t)) {
          // A REPL reads its program from stdin; an inspector opens a port that runs code.
          out.reasons.push(`${name} ${t.split("=")[0]} runs code the hook cannot see`);
          return;
        }
        const pre = /^(?:-r|--require|--import|--loader|--experimental-loader)(?:=(.*))?$/s.exec(t);
        const preVal = pre ? (pre[1] ?? texts[k + 1] ?? "") : null;
        if (
          preVal !== null &&
          ((/^[A-Za-z][\w+.-]*:/.test(preVal) && !/^node:/.test(preVal)) ||
            /^\/(?:dev|proc)\//.test(preVal))
        ) {
          out.reasons.push(`${name} preloads code from ${preVal.slice(0, 40)}`);
          return;
        }
        if (m) programs.push({ ...words[k], text: m[2] });
        else if (/^(?:-e|--eval|-p|--print|-pe|-ep)$/.test(t)) {
          programs.push(words[k + 1] ?? { text: "", missing: true });
          k += 2;
          continue;
        } else if (
          /^(?:-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--title|--input-type|--env-file|--stack-size|--inspect-port|--redirect-warnings|--report-directory|--cpu-prof-dir|--diagnostic-dir|--heap-prof-dir|--watch-path|--openssl-config|--icu-data-dir|--disable-proto|--max-http-header-size)$/.test(
            t,
          )
        ) {
          k += 2;
          continue;
        }
        k += 1;
        continue;
      }
      if (lang === "php") {
        const m = /^-([rBRE])(.*)$/s.exec(t);
        if (m && "rBRE".includes(m[1]) && t.length >= 2 && !t.startsWith("--")) {
          if (m[2]) programs.push({ ...words[k], text: m[2] });
          else {
            programs.push(words[k + 1] ?? { text: "", missing: true });
            k += 2;
            continue;
          }
          k += 1;
          continue;
        }
        if (t === "-f" || t === "--file") {
          script = texts[k + 1] ?? "";
          break;
        }
        if (t === "-a" || t === "--interactive") {
          out.reasons.push(`${name} -a reads its program from stdin`);
          return;
        }
        const ini = /^(?:-d|--define)(?:=?(.+))?$/s.exec(t);
        if (ini) {
          // `-d auto_prepend_file=php://stdin` runs a program the hook cannot see: only
          // settings that cannot load or write anything pass.
          const setting = (ini[1] ?? texts[k + 1] ?? "").split("=")[0].trim().toLowerCase();
          if (!PHP_SAFE_INI.has(setting)) {
            out.reasons.push(`${name} -d ${setting.slice(0, 40)} may load code or write files`);
            return;
          }
          k += ini[1] ? 1 : 2;
          continue;
        }
        if (/^(?:-c|-z|-F|--php-ini|--zend-extension)$/.test(t)) {
          k += 2;
          continue;
        }
        k += 1;
        continue;
      }
      // python, ruby, perl: bundled single-letter options (`-Ic`, `-lane`, `-pi.bak`, `-MJSON::PP`).
      if (t.startsWith("--")) {
        if (lang === "python" && t === "--check-hash-based-pycs") k += 1;
        k += 1;
        continue;
      }
      let j = 1;
      let consumedNext = false;
      while (j < t.length) {
        const ch = t[j];
        const progLetter =
          lang === "python" ? ch === "c" : ch === "e" || (lang === "perl" && ch === "E");
        if (progLetter) {
          const rest = t.slice(j + 1);
          if (rest) programs.push({ ...words[k], text: rest });
          else {
            programs.push(words[k + 1] ?? { text: "", missing: true });
            consumedNext = true;
          }
          break;
        }
        if (lang === "python" && ch === "m") {
          sawModule = true;
          const modName = t.slice(j + 1) || texts[k + 1] || "";
          if (!t.slice(j + 1) && words[k + 1] && argUnseen(words[k + 1], ctx)) {
            out.reasons.push(`${name} -m is given a module name the hook cannot see`);
            return;
          }
          const argv = texts.slice(t.slice(j + 1) ? k + 1 : k + 2);
          pythonModule(
            modName,
            argv,
            words.slice(t.slice(j + 1) ? k + 1 : k + 2),
            cwd,
            ctx,
            out,
            name,
          );
          break;
        }
        if (lang === "python" && ch === "i") {
          out.reasons.push(`${name} -i reads a program from stdin after its own`);
          return;
        }
        if (lang === "perl" && ch === "d") {
          out.reasons.push(`${name} -d runs a debugger or a Devel:: module the hook cannot see`);
          return;
        }
        if (lang === "perl" && ch === "F") {
          // `-F/pattern/` becomes `split(/pattern/)` in the program: a pattern can hold code.
          const pat = t.slice(j + 1);
          perlSplit = /^[/"']/.test(pat) ? pat : `'${pat.replace(/[\\']/g, "\\$&")}'`;
        }
        if (DIGIT_LETTERS[lang]?.has(ch)) {
          // `-l`, `-0777`, `-C7`, ruby `-T1`: optional digits, then more letters (`-lane`).
          j += 1;
          while (j < t.length && /[0-9]/.test(t[j])) j += 1;
          continue;
        }
        if (lang === "ruby" && ch === "K") {
          j += 2; // `-Ku`: one kcode letter
          continue;
        }
        if (VALUE_LETTERS[lang]?.has(ch)) {
          const rest = t.slice(j + 1);
          if (lang === "ruby" && ch === "C") {
            cwd = null;
            cwds = [null];
          }
          if ((lang === "ruby" && ch === "r") || (lang === "perl" && (ch === "M" || ch === "m"))) {
            preload.push(rest || texts[k + 1] || "");
          }
          // Letters whose value is optional and glued only.
          const gluedOnly =
            (lang === "perl" && "iFdDx".includes(ch)) || (lang === "ruby" && "ixF".includes(ch));
          if (!rest && !gluedOnly) consumedNext = true;
          break;
        }
        j += 1;
      }
      if (sawModule) break;
      k += consumedNext ? 2 : 1;
      if (lang === "python" && programs.length) break; // python: the rest is sys.argv
    }
  }
  const via = name;
  const texts2 = [];
  for (const p of programs) {
    if (p.missing) {
      out.reasons.push(`${via} is given its program by xargs or from input the hook cannot read`);
      continue;
    }
    if (feed?.placeholder && p.text.includes(feed.placeholder)) {
      out.reasons.push(`a ${via} program filled in by xargs, parallel or find from their input`);
      continue;
    }
    const why = unreadableWhy(p, ctx);
    if (why) {
      out.reasons.push(`${why} (${via})`);
      continue;
    }
    texts2.push(wordText(p, ctx));
  }
  if (perlSplit !== null) texts2.push(`split(${perlSplit}, $_);`);
  if (texts2.length) {
    // Ruby and Perl run every -e together, one per line; node and php the last one.
    const joined = lang === "ruby" || lang === "perl" ? [texts2.join("\n")] : texts2;
    for (const t of joined) {
      out.programs.push({ lang: progLang, text: t, cwd, cwds, via, preload });
    }
  } else if (preload.length && (lang === "ruby" || lang === "perl")) {
    out.programs.push({ lang: progLang, text: "", cwd, cwds, via, preload });
  }
  if (programs.length || sawModule) return;
  if (script !== null && /^\/(?:dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)$/.test(script))
    script = "-";
  if (script !== null && script !== "-" && script !== "") {
    // A script file: as invisible as a file the Write tool wrote (the documented residual).
    // With xargs appending words after it, they are the script's arguments.
    return;
  }
  if (feed?.appends && (script === null || script === "")) {
    // `printf '%s\n' -c 'code' | xargs python3`: the program can arrive as appended words.
    out.reasons.push(
      `${via} run by xargs or parallel with no program on the command line (its program could arrive from input)`,
    );
    return;
  }
  // No program on the command line: the interpreter reads its program from stdin.
  const sin = stdinOf(c, prev, ctx);
  if (sin.kind === "literal") {
    for (const t of sin.texts)
      out.programs.push({ lang: progLang, text: t, cwd, cwds, via: `${via} (stdin)`, preload });
  } else if (sin.kind === "unknown") {
    out.reasons.push(
      `${via} reads its program from stdin, from ${sin.why ?? "a source the hook cannot read"}`,
    );
  }
}

export { inlinePrograms, interpreterLang, lexShell };
