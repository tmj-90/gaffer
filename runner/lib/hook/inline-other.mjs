/**
 * Inline programs of the interpreters the capability rule does not lex (awk, sed, lua,
 * R, osascript, tcl and expect, make, sqlite3, dc). Each one is read only far enough to
 * find what it can do beyond printing: awk `system()`, pipes and `print > file`; sed `w`,
 * `e`, `r` and the `s///w` / `s///e` flags; sqlite3 dot-commands and SQL functions that
 * write or run commands, and its database file (a write); make's own command line
 * (`--eval`, a makefile on stdin, assignments make expands). Long options are matched
 * by any prefix GNU getopt accepts. A program that cannot be read this way, and any
 * inline program of lua, R, osascript, tclsh, expect or dc, is refused: those languages
 * are not modelled at all.
 *
 * Called by lib/hook/inline-programs.mjs for one simple command; it records reasons and
 * the literal paths a program writes (`{ lang: "writes" }`, judged against the write
 * roots by lib/hook/interpreters.mjs). Linear in the program length.
 *
 * Part of the safety hook's decision; see the map in runner/safety-hook-core.mjs.
 */

import { basename } from "node:path";

const AWKS = new Set(["awk", "gawk", "mawk", "nawk", "original-awk", "goawk", "onetrue-awk"]);
// Interpreters whose inline programs are refused outright (their flag that takes a
// program, or a program on stdin when no script file is named).
const UNMODELLED = {
  lua: ["-e"],
  luajit: ["-e"],
  Rscript: ["-e", "--expr"],
  R: ["-e"],
  osascript: ["-e"],
  tclsh: [],
  wish: [],
  expect: ["-c"],
  dc: ["-e", "--expression"],
};

/** Whether `name` is an interpreter this module reads. */
function otherInterpreterName(word) {
  const b = basename(word);
  return (
    AWKS.has(b) ||
    b === "sed" ||
    b === "gsed" ||
    b === "make" ||
    b === "gmake" ||
    b === "sqlite3" ||
    Object.prototype.hasOwnProperty.call(UNMODELLED, b) ||
    /^(?:lua|tclsh|wish)[0-9.]+$/.test(b)
  );
}

const WRITE_OK = /^\/dev\/(?:stdout|stderr|fd\/[12])$/;

// GNU getopt_long takes any unambiguous prefix of a long option (`sed --expr=...`, `gawk
// --so=...`, `make --ev=...`): the names in `names` that `--word[=value]` may stand for.
// An empty list means the word is not a long option.
function longOptionNames(word, names) {
  const m = /^--([A-Za-z][\w-]*)(?:=|$)/.exec(word);
  if (!m) return [];
  if (names.includes(m[1])) return [m[1]];
  return names.filter((n) => n.startsWith(m[1]));
}
// The value of `--name=value`, or null when the value is the next word.
function longOptionValue(word) {
  const eq = word.indexOf("=");
  return eq === -1 ? null : word.slice(eq + 1);
}
// A program file that is really stdin (`awk -f -`, `sed -f /dev/stdin`).
const STDIN_PATH = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

// A file descriptor other than stdin (`-f /dev/fd/3 3<<< '...'`): a program the hook
// cannot read. Exported for the interpreters and shells too.
const FD_PATH =
  /\/dev\/fd\/(?:[3-9]|\d{2,})(?!\d)|\/proc\/(?:self|thread-self|\d+)\/fd\/(?:[3-9]|\d{2,})(?!\d)/;

// Why a file an inline program reads (sed `r`, awk `getline <`) cannot be judged here, or
// null for a relative path without `..` under a known directory (inside the worktree);
// the read rules judge the operands, not the program text.
function readPathWhy(path, cwd) {
  if (!path) return "reads a file with no name";
  if (/^\/dev\/(?:stdin|fd\/0)$/.test(path)) return null;
  if (
    cwd === null ||
    path.startsWith("/") ||
    path.startsWith("~") ||
    path.split("/").includes("..")
  )
    return "reads a file the hook cannot judge";
  return null;
}

// The program texts of a `-f FILE` that names stdin, or a reason when they cannot be read.
function stdinProgram(stdin, via) {
  const sin = stdin();
  if (sin.kind === "literal") return { texts: sin.texts };
  return { why: `${via} reads its program from stdin, which the hook cannot read here` };
}

/**
 * Judge one command whose program is `texts[0]` (one of otherInterpreterName). `stdin` is
 * a function returning the command's stdin ({ kind, texts }). Returns true when handled.
 */
function otherInterpreter(texts, cwd, out, stdin) {
  const b = basename(texts[0]);
  const via = b;
  const unmod = Object.prototype.hasOwnProperty.call(UNMODELLED, b)
    ? UNMODELLED[b]
    : /^(?:lua|tclsh|wish)[0-9.]+$/.test(b)
      ? b.startsWith("lua")
        ? ["-e"]
        : []
      : null;
  if (unmod) {
    const flag = texts
      .slice(1)
      .find((t) => unmod.includes(t) || unmod.some((f) => t.startsWith(f + "=")));
    if (flag) {
      out.reasons.push(
        `${via} ${flag.split("=")[0]} runs an inline program in a language the hook does not read`,
      );
      return true;
    }
    const script = texts.slice(1).find((t) => !t.startsWith("-"));
    if (!script || script === "-" || /^\/dev\/(?:stdin|fd\/0)$/.test(script)) {
      const sin = stdin();
      if (sin.kind === "literal" || sin.kind === "unknown") {
        out.reasons.push(`${via} reads a program from stdin in a language the hook does not read`);
      }
    }
    return true; // a script file: the documented residual
  }
  if (b === "make" || b === "gmake") {
    const why = makeWhy(texts);
    if (why) out.reasons.push(`${via} ${why}`);
    return true;
  }
  if (b === "sqlite3") return sqlite(texts, cwd, out, stdin, via);
  if (AWKS.has(b)) return awk(texts, cwd, out, via, stdin);
  if (b === "sed" || b === "gsed") return sed(texts, cwd, out, via, stdin);
  return false;
}

// ---------------------------------------------------------------------
// make: recipes come from a makefile (the documented residual); what the command line
// itself makes make read or run is judged here.
// ---------------------------------------------------------------------
const MAKE_LONG = (
  "always-make directory debug environment-overrides eval file makefile help " +
  "ignore-errors include-dir jobs keep-going load-average max-load check-symlink-times " +
  "just-print dry-run recon old-file assume-old output-sync print-data-base question " +
  "no-builtin-rules no-builtin-variables shuffle silent quiet no-silent stop " +
  "no-keep-going touch trace version print-directory no-print-directory what-if new-file " +
  "assume-new warn-undefined-variables jobserver-auth jobserver-style"
).split(" ");
// Short options that take a value (glued or as the next word).
const MAKE_VALUE_LETTERS = new Set(["C", "E", "f", "I", "o", "W"]);
// Variables a command-line assignment may not set: they make make read more makefile
// text or run recipes through another program.
const MAKE_CONTROL_VARS = new Set([
  "MAKEFLAGS",
  "MFLAGS",
  "GNUMAKEFLAGS",
  "MAKEFILES",
  "MAKESHELL",
  ".SHELLFLAGS",
  "MAKE",
]);

function makeWhy(texts) {
  const stdinFile = (file) =>
    STDIN_PATH.test(file ?? "")
      ? "reads a makefile from stdin, which the hook does not read"
      : null;
  for (let k = 1; k < texts.length; k += 1) {
    const t = texts[k];
    if (t === "--") continue;
    if (t.startsWith("--")) {
      const names = longOptionNames(t, MAKE_LONG);
      const val = longOptionValue(t);
      if (names.includes("eval")) return "evaluates make text given on its command line (--eval)";
      if (names.some((n) => n === "file" || n === "makefile")) {
        const why = stdinFile(val ?? texts[k + 1]);
        if (why) return why;
      }
      if (
        val === null &&
        names.length === 1 &&
        /^(?:directory|include-dir|file|makefile|assume-old|old-file|what-if|new-file|assume-new)$/.test(
          names[0],
        )
      )
        k += 1;
      continue;
    }
    if (t.startsWith("-") && t !== "-") {
      for (let j = 1; j < t.length; j += 1) {
        const ch = t[j];
        if (ch === "E") return "evaluates make text given on its command line (-E)";
        if (MAKE_VALUE_LETTERS.has(ch)) {
          const val = t.slice(j + 1) || texts[k + 1];
          if (ch === "f") {
            const why = stdinFile(val);
            if (why) return why;
          }
          if (!t.slice(j + 1)) k += 1;
          break;
        }
        if (ch === "j" || ch === "l" || ch === "O") break; // an optional glued value
      }
      continue;
    }
    // A variable assignment on the command line: make expands its value whenever a
    // recipe runs (command-line variables are exported), `:=` and `!=` at once, and the
    // name too, so a `$` anywhere in it runs make functions (`$(shell ...)`).
    const m = /^([^=]*?)(::?:?=|!=|\?=|\+=|=)(.*)$/s.exec(t);
    if (m) {
      if (m[2] === "!=") return `runs a shell command in an assignment (${t.slice(0, 40)})`;
      if (/[$`]/.test(m[1]) || m[3].includes("$")) {
        return `is given an assignment that make expands into a function call (${t.slice(0, 40)})`;
      }
      const name = m[1].trim();
      if (MAKE_CONTROL_VARS.has(name)) {
        return `sets ${name} on its command line (more make text or another recipe program)`;
      }
      if (name === "SHELL" && !/^(?:\/[\w./-]*\/)?(?:ba|da|z|k|mk)?sh$/.test(m[3])) {
        return `runs its recipes through ${m[3].slice(0, 40)} (SHELL)`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// sqlite3: dot-commands and SQL that write files or run commands.
// ---------------------------------------------------------------------
// Dot-commands that write files, read commands or files, or run programs. The shell
// takes an abbreviation (`.sh`, `.o`, `.rea`), so a command whose name is a prefix of
// one of these is refused.
const SQLITE_DOT_BAD = (
  "shell system output once save backup clone import load open log excel trace read " +
  "restore cd archive ar iotrace www session testcase"
).split(" ");
// SQL functions and virtual tables that write or read files or load code.
const SQLITE_FUNC_BAD =
  /\b(?:writefile|edit|load_extension|fts3_tokenizer|readfile|fsdir|zipfile|sqlar_uncompress)\s*\(/i;
const SQLITE_VALUE_OPTS = new Set([
  "cmd",
  "separator",
  "newline",
  "nullvalue",
  "vfs",
  "maxsize",
  "mmap",
  "escape",
]);
const SQLITE_TWO_VALUE_OPTS = new Set(["pagecache", "lookaside", "heap"]);

// SQL text with comments removed and identifier quotes (`"x"`, `` `x` ``, `[x]`) turned
// into spaces, string literals kept: what the parser sees as names. Linear.
function sqlNames(src) {
  let out = "";
  const n = src.length;
  for (let i = 0; i < n; i += 1) {
    const c = src[i];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? n : end + 1;
      out += src.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (c === "-" && src[i + 1] === "-") {
      const eol = src.indexOf("\n", i);
      i = eol === -1 ? n : eol - 1;
      out += " ";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 1;
      out += " ";
      continue;
    }
    out += c === '"' || c === "`" || c === "[" || c === "]" ? " " : c;
  }
  return out;
}

// Why a sqlite3 argument or input text can write files, run programs or read files the
// hook cannot judge, or null.
function sqliteWhy(text) {
  for (const m of text.matchAll(/(?:^|[\s;])\.([A-Za-z_]\w*)/g)) {
    const name = m[1].toLowerCase();
    const bad = SQLITE_DOT_BAD.find((d) => d.startsWith(name));
    if (bad) return `the dot-command .${m[1]} (.${bad})`;
  }
  const sql = sqlNames(text);
  if (SQLITE_FUNC_BAD.test(sql))
    return `a function that reaches files or code (${text.slice(0, 40)})`;
  if (/\battach\b/i.test(sql)) return `ATTACH (${text.slice(0, 40)})`;
  for (const stmt of sql.split(";")) {
    if (/\bvacuum\b/i.test(stmt) && /\binto\b/i.test(stmt)) return "VACUUM INTO";
  }
  return null;
}

function sqlite(texts, cwd, out, stdin, via) {
  let db = null;
  let readonly = false;
  for (let k = 1; k < texts.length; k += 1) {
    const t = texts[k];
    if (/^-A/.test(t) || /^--?(?:archive|init)$/.test(t)) {
      out.reasons.push(`${via} ${t} writes files or reads commands from a file`);
      return true;
    }
    const why = sqliteWhy(t);
    if (why) {
      out.reasons.push(`${via} is given a command that writes files or runs programs: ${why}`);
      return true;
    }
  }
  // Options may stand anywhere; the first other word is the database, the rest SQL.
  for (let k = 1; k < texts.length; k += 1) {
    const t = texts[k];
    if (t.startsWith("-")) {
      const opt = t.replace(/^--?/, "");
      if (opt === "readonly") readonly = true;
      if (SQLITE_VALUE_OPTS.has(opt)) k += 1;
      else if (SQLITE_TWO_VALUE_OPTS.has(opt)) k += 2;
      continue;
    }
    if (db === null) db = t;
  }
  const sin = stdin();
  if (sin.kind === "unknown" || (sin.kind === "literal" && sin.texts.some((t) => sqliteWhy(t)))) {
    out.reasons.push(`${via} reads commands from stdin that may write files or run programs`);
    return true;
  }
  // The database file is created or changed by any write statement: judged as a write
  // unless it is opened read-only.
  if (db !== null && db !== "" && db !== ":memory:" && !readonly) {
    let path = db;
    if (/^file:/i.test(path)) {
      const q = path.search(/[?#]/);
      const query = q === -1 ? "" : path.slice(q);
      if (/[?&](?:mode=(?:ro|memory)|immutable=1)\b/.test(query)) return true;
      path = path.slice(5, q === -1 ? undefined : q).replace(/^\/\/(?:localhost)?(?=\/)/, "");
      if (path === "" || path === ":memory:") return true;
    }
    out.programs.push({
      lang: "writes",
      paths: [path],
      cwd,
      via,
      what: `${via} database (opening creates it; use -readonly to only read)`,
    });
  }
  return true;
}

// ---------------------------------------------------------------------
// awk
// ---------------------------------------------------------------------
// gawk's long options (5.3), those that load or include code, run the debugger or write
// a file, and those that take a value.
const AWK_LONG = (
  "assign bignum characters-as-bytes copyright csv debug dump-variables exec " +
  "field-separator file gen-pot help include lint lint-old load no-optimize " +
  "non-decimal-data optimize persist posix pretty-print profile re-interval sandbox " +
  "source trace traditional use-lc-numeric version"
).split(" ");
const AWK_LONG_BAD = new Set([
  "debug",
  "dump-variables",
  "exec",
  "include",
  "load",
  "persist",
  "pretty-print",
  "profile",
]);
const AWK_LONG_VALUE = new Set(["assign", "field-separator"]);
function awk(texts, cwd, out, via, stdin) {
  const programs = [];
  let script = false;
  let k = 1;
  const programFile = (file) => {
    script = true;
    if (!STDIN_PATH.test(file)) return true; // a program file: the documented residual
    const p = stdinProgram(stdin, via);
    if (p.why) {
      out.reasons.push(p.why);
      return false;
    }
    programs.push(...p.texts);
    return true;
  };
  const refuse = (opt) => {
    out.reasons.push(
      `${via} ${opt} loads an extension or a source file, runs a debugger or writes a file (gawk -i inplace, -d, -o, -p)`,
    );
    return true;
  };
  for (; k < texts.length; k += 1) {
    const t = texts[k];
    if (t === "--") {
      k += 1;
      break;
    }
    if (!t.startsWith("-") || t === "-") break;
    if (t.startsWith("--")) {
      // gawk takes any unambiguous prefix (`--so=`, `--lo=`): a word that may stand for
      // an option that loads, includes, debugs or writes is refused.
      const names = longOptionNames(t, AWK_LONG);
      const val = longOptionValue(t);
      if (names.length === 0) continue; // not a gawk option: awk refuses it
      if (names.some((n) => AWK_LONG_BAD.has(n))) return refuse(t.split("=")[0]);
      if (names.length > 1) continue; // ambiguous: gawk refuses it
      if (names[0] === "source") {
        programs.push(val ?? texts[k + 1] ?? "");
        if (val === null) k += 1;
      } else if (names[0] === "file") {
        if (!programFile(val ?? texts[k + 1] ?? "")) return true;
        if (val === null) k += 1;
      } else if (AWK_LONG_VALUE.has(names[0]) && val === null) k += 1;
      continue;
    }
    // A cluster of short options (`-bv x=1`, `-d/tmp/f`).
    let consumed = false;
    for (let j = 1; j < t.length; j += 1) {
      const ch = t[j];
      const glued = t.slice(j + 1);
      if ("dDopEilW".includes(ch)) return refuse(`-${ch}`);
      if (ch === "f") {
        if (!programFile(glued || texts[k + 1] || "")) return true;
        consumed = !glued;
        break;
      }
      if (ch === "e") {
        programs.push(glued || texts[k + 1] || "");
        consumed = !glued;
        break;
      }
      if (ch === "v" || ch === "F") {
        consumed = !glued;
        break;
      }
    }
    if (consumed) k += 1;
  }
  if (!script && programs.length === 0 && k < texts.length) programs.push(texts[k]);
  for (const p of programs) {
    const why = awkWhy(p, cwd, out, via);
    if (why) {
      out.reasons.push(`${via} program ${why}`);
      return true;
    }
  }
  return true;
}

// Replace awk strings and regex literals by placeholders; return { code, strings }.
function awkScrub(src) {
  let code = "";
  const strings = [];
  let lastSig = "";
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === "#") {
      const eol = src.indexOf("\n", i);
      i = eol === -1 ? src.length : eol - 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          v += src[j + 1];
          j += 2;
          continue;
        }
        v += src[j];
        j += 1;
      }
      if (j >= src.length) return null;
      code += ` \uE001${strings.length} `;
      strings.push(v);
      lastSig = "s";
      i = j;
      continue;
    }
    if (c === "/" && (lastSig === "" || /[(,~!{};&|\n?:=]/.test(lastSig))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && (src[j] !== "/" || inClass)) {
        if (src[j] === "\\") j += 1;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "\n") return null;
        j += 1;
      }
      if (j >= src.length) return null;
      code += " \uE002 ";
      lastSig = "r";
      i = j;
      continue;
    }
    code += c;
    if (!/\s/.test(c) || c === "\n") lastSig = c;
  }
  return { code, strings };
}

function awkWhy(src, cwd, out, via) {
  const scrubbed = awkScrub(src);
  if (scrubbed === null) return "cannot be read by the hook (an unterminated string or regex)";
  const { code, strings } = scrubbed;
  if (/\bsystem\s*\(/.test(code)) return "runs a command (system)";
  if (code.replace(/\|\|/g, "  ").includes("|")) return "pipes to or from a command";
  // `@load`, `@include`, and gawk's indirect call `@f(...)` (with f = "system").
  if (code.includes("@") || /\bextension\s*\(/.test(code)) {
    return "loads an extension or calls a function named at run time (@)";
  }
  // `getline [var] < FILE` reads a file: a literal path the read rules would allow, or
  // the input operands (FILENAME, ARGV[n]); anything else is a read the hook cannot judge.
  for (const m of code.matchAll(/\bgetline\b\s*(?:[A-Za-z_]\w*\s*)?<\s*(\S{0,32})/g)) {
    const tgt = m[1];
    const lit = /^(\d+)/.exec(tgt);
    if (lit) {
      const why = readPathWhy(strings[Number(lit[1])], cwd);
      if (why) return `${why} (getline <)`;
    } else if (!/^(?:FILENAME|ARGV\[)/.test(tgt)) {
      return "reads a file named at run time (getline <)";
    }
  }
  // `print ... > target` at paren depth 0 in a print/printf statement is a redirection.
  for (const m of code.matchAll(/\bprintf?\b/g)) {
    let depth = 0;
    for (let j = m.index + m[0].length; j < code.length; j += 1) {
      const ch = code[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if ((ch === ";" || ch === "}" || ch === "\n" || ch === "{") && depth <= 0) break;
      else if (ch === ">" && depth <= 0) {
        let r = j + 1;
        if (code[r] === ">") r += 1;
        const target = /^\s*\uE001(\d+)\s*(?=[;}\n]|$)/.exec(code.slice(r));
        if (!target) return "writes to a file named at run time (print >)";
        const path = strings[Number(target[1])];
        if (!WRITE_OK.test(path)) {
          out.programs.push({ lang: "writes", paths: [path], cwd, via, what: `${via} print >` });
        }
        break;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// sed
// ---------------------------------------------------------------------
const SED_LONG = (
  "binary debug expression file follow-symlinks help in-place line-length null-data " +
  "zero-terminated posix quiet silent regexp-extended sandbox separate unbuffered version"
).split(" ");
function sed(texts, cwd, out, via, stdin) {
  const scripts = [];
  let fileScript = false;
  const programFile = (file) => {
    fileScript = true;
    if (!STDIN_PATH.test(file)) return true;
    const p = stdinProgram(stdin, via);
    if (p.why) {
      out.reasons.push(p.why);
      return false;
    }
    scripts.push(...p.texts);
    return true;
  };
  let k = 1;
  let sandbox = false;
  // The words that are not options or option values, with whether each follows a bare
  // `-i` / `-I` (BSD sed takes the next word as the backup suffix: `sed -i '' SCRIPT`).
  const operands = [];
  for (; k < texts.length; k += 1) {
    const t = texts[k];
    if (t === "--") {
      for (const o of texts.slice(k + 1)) operands.push({ text: o, afterI: false });
      break;
    }
    if (!t.startsWith("-") || t === "-") {
      operands.push({ text: t, afterI: texts[k - 1] === "-i" || texts[k - 1] === "-I" });
      continue;
    }
    if (t.startsWith("--")) {
      // GNU takes any unambiguous prefix (`--expr=`, `--fi=`).
      const names = longOptionNames(t, SED_LONG);
      const val = longOptionValue(t);
      // `--sandbox` (sed refuses e, r and w) counts only before the script: after it, BSD
      // sed and a POSIXLY_CORRECT GNU sed read it as a file name.
      if (t === "--sandbox" && operands.length === 0) sandbox = true;
      if (names.length !== 1) continue; // ambiguous or unknown: sed refuses it
      if (names[0] === "expression") {
        scripts.push(val ?? texts[k + 1] ?? "");
        if (val === null) k += 1;
      } else if (names[0] === "file") {
        if (!programFile(val ?? texts[k + 1] ?? "")) return true;
        if (val === null) k += 1;
      } else if (names[0] === "line-length" && val === null) k += 1;
      continue;
    }
    if (t === "-l") {
      k += 1;
      continue;
    }
    if (/^-[nrEsuz]*e/.test(t)) {
      const glued = t.slice(t.indexOf("e") + 1);
      scripts.push(glued || (texts[k + 1] ?? ""));
      if (!glued) k += 1;
      continue;
    }
    if (/^-[nrEsuz]*f/.test(t)) {
      const glued = t.slice(t.indexOf("f") + 1);
      if (!programFile(glued || texts[k + 1] || "")) return true;
      if (!glued) k += 1;
    }
  }
  if (sandbox) return true;
  if (scripts.length === 0 && !fileScript && operands.length) {
    // `sed -i '' SCRIPT FILE` / `sed -i .bak SCRIPT FILE` (BSD): the script is the word
    // after the suffix. GNU reads the suffix as the script and stops on it.
    const bsd = operands[0].afterI && /^(?:|\.[\w.~-]*)$/.test(operands[0].text);
    if (bsd && operands.length > 1) scripts.push(operands[1].text);
    if (!bsd) scripts.push(operands[0].text);
  }
  for (const s of scripts) {
    const why = sedWhy(s, cwd, out, via);
    if (why) {
      out.reasons.push(`${via} script ${why}`);
      return true;
    }
  }
  return true;
}

// Read a sed script command by command: what it writes, runs or reads besides its input.
function sedWhy(src, cwd, out, via) {
  const n = src.length;
  let i = 0;
  const write = (path) => {
    if (!WRITE_OK.test(path))
      out.programs.push({ lang: "writes", paths: [path], cwd, via, what: `${via} w` });
  };
  const toEol = (j) => {
    const e = src.indexOf("\n", j);
    return e === -1 ? n : e;
  };
  const skipRegex = (j) => {
    // j at the delimiter; returns the index after the closing delimiter, or -1.
    const d = src[j];
    if (d === undefined || d === "\n" || d === "\\") return -1;
    for (let q = j + 1; q < n; q += 1) {
      if (src[q] === "\\") q += 1;
      else if (src[q] === d) return q + 1;
      else if (src[q] === "\n") return -1;
    }
    return -1;
  };
  const address = (j) => {
    if (/[0-9]/.test(src[j] ?? "")) {
      while (/[0-9~]/.test(src[j] ?? "")) j += 1;
      return j;
    }
    if (src[j] === "$") return j + 1;
    if (src[j] !== "/" && src[j] !== "\\") return j;
    let e = src[j] === "/" ? skipRegex(j) : skipRegex(j + 1);
    // GNU address flags: `/re/I`, `/re/M`.
    while (e !== -1 && (src[e] === "I" || src[e] === "M")) e += 1;
    return e;
  };
  let guard = 0;
  while (i < n) {
    if (guard++ > n + 8) return "cannot be read by the hook";
    const c = src[i];
    if (/[\s;}]/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "#") {
      i = toEol(i);
      continue;
    }
    let j = address(i);
    if (j === -1) return "cannot be read by the hook (an unterminated address)";
    if (src[j] === ",") {
      j = address(j + 1);
      if (j === -1) return "cannot be read by the hook (an unterminated address)";
      if (src[j] === "+" || src[j] === "~") {
        j += 1;
        while (/[0-9]/.test(src[j] ?? "")) j += 1;
      }
    }
    while (src[j] === " " || src[j] === "\t" || src[j] === "!") j += 1;
    const cmd = src[j];
    if (cmd === undefined) return null;
    if (cmd === "{") {
      i = j + 1;
      continue;
    }
    if (cmd === "e") return "runs a command (e)";
    if (cmd === "w" || cmd === "W") {
      const end = toEol(j + 1);
      write(src.slice(j + 1, end).trim());
      i = end;
      continue;
    }
    if (cmd === "r" || cmd === "R") {
      const file = src.slice(j + 1, toEol(j + 1)).trim();
      const why = /^\/dev\/stdin$/.test(file) ? null : readPathWhy(file, cwd);
      if (why) return `${why} (${cmd} ${file.slice(0, 40)})`;
      i = toEol(j + 1);
      continue;
    }
    if (cmd === "a" || cmd === "i" || cmd === "c") {
      // Text to the end of the line (a backslash-newline continues it).
      let e = j + 1;
      while (e < n && src[e] !== "\n") e += src[e] === "\\" ? 2 : 1;
      i = e;
      continue;
    }
    if (cmd === "b" || cmd === "t" || cmd === "T" || cmd === ":") {
      let e = j + 1;
      while (e < n && src[e] !== "\n" && src[e] !== ";") e += 1;
      i = e;
      continue;
    }
    if (cmd === "s" || cmd === "y") {
      const d = src[j + 1];
      if (d === undefined || d === "\\" || d === "\n") return "cannot be read by the hook";
      let q = j + 2;
      for (let part = 0; part < 2; part += 1) {
        while (q < n && src[q] !== d) {
          if (src[q] === "\\") q += 1;
          q += 1;
        }
        if (q >= n) return "cannot be read by the hook (an unterminated s or y command)";
        q += 1;
      }
      if (cmd === "s") {
        // Flags: g p i I m M e digits, then w FILE to the end of the line.
        while (q < n && /[gpiImM0-9e]/.test(src[q])) {
          if (src[q] === "e") return "runs the pattern space as a command (s///e)";
          q += 1;
        }
        if (src[q] === "w") {
          const end = toEol(q + 1);
          write(src.slice(q + 1, end).trim());
          q = end;
        }
      }
      i = q;
      continue;
    }
    if (/[=dDgGhHlnNpPqQxzF]/.test(cmd)) {
      i = j + 1;
      if (
        (cmd === "q" || cmd === "Q" || cmd === "l" || cmd === "L") &&
        /[0-9]/.test(src[i] ?? "")
      ) {
        while (/[0-9]/.test(src[i] ?? "")) i += 1;
      }
      continue;
    }
    return `cannot be read by the hook (an unknown command ${JSON.stringify(cmd)})`;
  }
  return null;
}

export { FD_PATH, otherInterpreter, otherInterpreterName };
