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
import { replayCd } from "./paths.mjs";
import { resolveEffectiveTokens } from "./verbs.mjs";

const MAX_DEPTH = 6;

/** The language of an interpreter program name, or null. */
function interpreterLang(word) {
  const b = basename(word);
  if (/^(?:python|pypy)[0-9.]*$/.test(b)) return "python";
  if (/^(?:node|nodejs|bun|tsx|ts-node|ts-node-esm|esno|esr|babel-node)$/.test(b)) return "js";
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
  const endCmd = (op) => {
    endWord();
    if (words.length || redirs.length) cmds.push({ words, redirs, op });
    else if (cmds.length && (op === "|" || op === "|&")) cmds[cmds.length - 1].op = op;
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
      return end;
    }
    if (nx === "{") {
      const end = matchBrace(cmd, k + 1);
      const inner = cmd.slice(k + 2, end - 1);
      word.text += cmd.slice(k, end);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) word.vars.push(inner);
      else word.subst = true; // `${X:-$(cmd)}`, `${!X}`, `${X/a/b}`: not followed
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
      if (word && /^[0-9]+$/.test(word.text) && !word.quoted)
        word = null; // an fd number
      else endWord();
      let op = "";
      const m = /^(?:<<<|<<-|<<|<>|<&|<|>>|>&|>\||>|&>>|&>)/.exec(cmd.slice(i, i + 3));
      op = m[0];
      i += op.length;
      if (op === "<(" || (op === "<" && cmd[i] === "(")) {
        // Process substitution: a command of its own (judged by the other rules).
        newWord();
        const end = matchParen(cmd, i);
        word.text += "<" + cmd.slice(i, end);
        word.subst = true;
        i = end;
        continue;
      }
      pendingRedir = { op };
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
  return { cmds };
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
 * The inline programs of `cmd`: { programs: [{ lang, text, cwd, via }], reasons: [] }.
 * `cwd` is where the program runs (null when a `cd` the hook cannot follow came first).
 */
let LAST = { cmd: null, cwd: null, out: null };
function inlinePrograms(cmd, cwd = process.cwd()) {
  // The capability rule and the read rule ask for the same command: read it once.
  if (LAST.cmd === cmd && LAST.cwd === cwd) return LAST.out;
  const out = { programs: [], reasons: [] };
  walk(cmd, { cwd, vars: new Map(), depth: 0, raw: cmd, sets: new Map() }, out);
  LAST = { cmd, cwd, out };
  return out;
}

function walk(text, ctx, out) {
  if (ctx.depth > MAX_DEPTH) {
    if (interpreterMentioned(text)) {
      out.reasons.push("an interpreter nested deeper than the hook reads (shells in shells)");
    }
    return;
  }
  const lexed = lexShell(text);
  if (lexed.error) {
    if (interpreterMentioned(text)) {
      out.reasons.push(`the command cannot be read as the shell will run it (${lexed.error})`);
    }
    return;
  }
  const { cmds } = lexed;
  for (let k = 0; k < cmds.length; k += 1) {
    const prev = k > 0 && (cmds[k - 1].op === "|" || cmds[k - 1].op === "|&") ? cmds[k - 1] : null;
    simple(cmds[k], prev, ctx, out);
  }
}

function interpreterMentioned(text) {
  for (const m of text.matchAll(/[A-Za-z][\w.-]*/g)) if (interpreterLang(m[0])) return true;
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
    k += 1;
  }
  return k;
}

// The stdin of a simple command: { kind: "none" | "literal" | "file" | "unknown", texts }.
function stdinOf(c, prev, ctx) {
  for (const r of c.redirs) {
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
  for (const w of words.slice(0, firstNonAssign)) ctx.vars.set(ASSIGN.exec(w.text)[1], null);
  const w0 = words[firstNonAssign].text;
  if (["export", "declare", "local", "readonly", "typeset"].includes(w0)) {
    let k = firstNonAssign + 1;
    while (k < words.length && words[k].text.startsWith("-")) k += 1;
    recordAssignments(words, ctx, k);
    return;
  }
  if (w0 === "read" || w0 === "mapfile" || w0 === "readarray" || w0 === "getopts") {
    for (const w of words.slice(firstNonAssign + 1)) {
      if (/^[A-Za-z_]\w*$/.test(w.text)) ctx.vars.set(w.text, null);
    }
    return;
  }
  if (w0 === "for" || w0 === "select") {
    const name = words[firstNonAssign + 1]?.text;
    if (name && /^[A-Za-z_]\w*$/.test(name)) ctx.vars.set(name, null);
    return;
  }
  inspectWords(words.slice(firstNonAssign), c, prev, ctx, out, feed);
}

// Follow one command's words to the program that runs; record inline programs.
function inspectWords(words, c, prev, ctx, out, feed, guard = 0) {
  if (guard > 24 || words.length === 0) return;
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
  if (first === "cd" || first === "pushd" || first === "popd") {
    const arg = texts.slice(1).find((t) => !/^-[LPe@]+$/.test(t));
    const relative = arg !== undefined && !arg.startsWith("/") && !arg.startsWith("~");
    if (first !== "cd" || (relative && (process.env.CDPATH || /CDPATH/.test(ctx.raw)))) {
      ctx.cwd = null; // the directory stack and CDPATH are unknown to a stateless hook
    } else ctx.cwd = replayCd({ verb: "cd", rest: texts }, ctx.cwd);
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
        ctx.cwd = null;
      if (t === "-u" || t === "--unset" || t === "-C" || t === "--chdir") {
        k += 2;
        continue;
      }
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
  const lang = interpreterLang(texts[0]);
  if (lang) return interpreter(lang, words, c, prev, ctx, out, feed);
  if (SHELLS.has(first) || (first === "busybox" && SHELLS.has(texts[1] ?? ""))) {
    const ws = first === "busybox" ? words.slice(1) : words;
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
      const why = unreadableWhy(body, ctx);
      if (why && interpreterMentioned(body.text)) out.reasons.push(why);
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
    if (why && interpreterMentioned(body)) out.reasons.push(why);
    // eval runs in the current shell: a `cd` in it moves the commands after it.
    ctx.depth += 1;
    walk(body, ctx, out);
    ctx.depth -= 1;
    return;
  }
  if (first === "source" || first === ".") {
    ctx.cwd = null; // a sourced file can change directory
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

/**
 * Find the inline programs of one interpreter invocation (`words` start at the
 * interpreter) and record them, or a reason when the program cannot be seen.
 */
function interpreter(lang, words, c, prev, ctx, out, feed) {
  const texts = words.map((w) => wordText(w, ctx));
  const programs = []; // words (or { text }) that hold program text
  let script = null; // the first operand: a script file (or the end of the options)
  let cwd = ctx.cwd;
  let sawModule = false;
  const preload = []; // ruby -r LIB, perl -M MODULE
  const progLang = lang === "deno" ? "js" : lang;
  const name = basename(texts[0]);
  let k = 1;
  if (lang === "deno") {
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
    } else {
      script = sub; // deno task / test / x / install: files and packages, not inline text
    }
  } else {
    while (k < texts.length) {
      const t = texts[k];
      if (words[k].subst || words[k].dynamic || /[$`]/.test(t)) {
        // `python3 "$@"`, `node $ARGS`: an option or the script could be a program flag.
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
        if (/^(?:-d|-c|-z|-F|--define|--php-ini|--zend-extension)$/.test(t)) {
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
          break;
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
          if (lang === "ruby" && ch === "C") cwd = null;
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
  if (texts2.length) {
    // Ruby and Perl run every -e together, one per line; node and php the last one.
    const joined = lang === "ruby" || lang === "perl" ? [texts2.join("\n")] : texts2;
    for (const t of joined) out.programs.push({ lang: progLang, text: t, cwd, via, preload });
  } else if (preload.length && (lang === "ruby" || lang === "perl")) {
    out.programs.push({ lang: progLang, text: "", cwd, via, preload });
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
      out.programs.push({ lang: progLang, text: t, cwd, via: `${via} (stdin)`, preload });
  } else if (sin.kind === "unknown") {
    out.reasons.push(
      `${via} reads its program from stdin, from ${sin.why ?? "a source the hook cannot read"}`,
    );
  }
}

export { inlinePrograms, interpreterLang, lexShell };
