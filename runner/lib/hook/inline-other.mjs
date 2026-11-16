/**
 * Inline programs of the interpreters the capability rule does not lex (awk, sed, lua,
 * R, osascript, tcl and expect, make, sqlite3, dc). Each one is read only far enough to
 * find what it can do beyond printing: awk `system()`, pipes and `print > file`; sed `w`,
 * `e`, `r` and the `s///w` / `s///e` flags; sqlite3 dot-commands and SQL functions that
 * write or run commands. A program that cannot be read this way, and any inline program
 * of lua, R, osascript, tclsh, expect, make or dc, is refused: those languages are not
 * modelled at all.
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
// A program file that is really stdin (`awk -f -`, `sed -f /dev/stdin`).
const STDIN_PATH = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

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
    for (let k = 1; k < texts.length; k += 1) {
      const t = texts[k];
      const file =
        t === "-f" || t === "--file" || t === "--makefile"
          ? texts[k + 1]
          : /^(?:-f|--file=|--makefile=)(.+)$/.exec(t)?.[1];
      if ((file && STDIN_PATH.test(file)) || /^(?:--eval(?:=|$)|-E)/.test(t)) {
        out.reasons.push(
          `${via} runs recipes given inline or on stdin, which the hook does not read`,
        );
        return true;
      }
    }
    return true;
  }
  if (b === "sqlite3") return sqlite(texts, out, stdin, via);
  if (AWKS.has(b)) return awk(texts, cwd, out, via, stdin);
  if (b === "sed" || b === "gsed") return sed(texts, cwd, out, via, stdin);
  return false;
}

// ---------------------------------------------------------------------
// sqlite3: dot-commands and SQL that write files or run commands.
// ---------------------------------------------------------------------
const SQLITE_BAD =
  /(?:^|[\s;])\.(?:shell|system|output|once|save|backup|clone|import|load|open|log|excel|trace|read|cd|archive|ar|iotrace)\b|\b(?:writefile|edit|load_extension|fts3_tokenizer)\s*\(|\battach\b|\bvacuum\s+into\b/i;

function sqlite(texts, out, stdin, via) {
  for (let k = 1; k < texts.length; k += 1) {
    const t = texts[k];
    if (/^-A/.test(t) || /^--?(?:archive|init)$/.test(t)) {
      out.reasons.push(`${via} ${t} writes files or reads commands from a file`);
      return true;
    }
    if (SQLITE_BAD.test(t)) {
      out.reasons.push(
        `${via} is given a command that writes files or runs programs (${t.slice(0, 40)})`,
      );
      return true;
    }
  }
  const sin = stdin();
  if (
    sin.kind === "unknown" ||
    (sin.kind === "literal" && sin.texts.some((t) => SQLITE_BAD.test(t)))
  ) {
    out.reasons.push(`${via} reads commands from stdin that may write files or run programs`);
  }
  return true;
}

// ---------------------------------------------------------------------
// awk
// ---------------------------------------------------------------------
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
  for (; k < texts.length; k += 1) {
    const t = texts[k];
    if (t === "--") {
      k += 1;
      break;
    }
    if (!t.startsWith("-") || t === "-") break;
    if (/^(?:-l|--load|-i|--include|-E|--exec|-W)(?:=.*)?$/.test(t) || /^-[liW]./.test(t)) {
      out.reasons.push(
        `${via} ${t.split("=")[0]} loads an extension, a source file or a long option (gawk -i inplace edits files)`,
      );
      return true;
    }
    if (t === "-f" || t === "--file") {
      if (!programFile(texts[k + 1] ?? "")) return true;
      k += 1;
      continue;
    }
    if (/^-f./.test(t) || t.startsWith("--file=")) {
      if (!programFile(t.startsWith("--file=") ? t.slice(7) : t.slice(2))) return true;
      continue;
    }
    if (t === "-e" || t === "--source") {
      programs.push(texts[k + 1] ?? "");
      k += 1;
      continue;
    }
    if (t.startsWith("--source=")) {
      programs.push(t.slice(9));
      continue;
    }
    if (t === "-F" || t === "-v" || t === "--assign" || t === "--field-separator") {
      k += 1;
      continue;
    }
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
  for (; k < texts.length; k += 1) {
    const t = texts[k];
    if (t === "--sandbox") return true; // sed itself refuses e, r and w
    if (t === "--") break;
    if (!t.startsWith("-") || t === "-") continue;
    if (t === "-e" || t === "--expression") {
      scripts.push(texts[k + 1] ?? "");
      k += 1;
      continue;
    }
    if (t.startsWith("--expression=")) {
      scripts.push(t.slice(13));
      continue;
    }
    if (t === "-f" || t === "--file") {
      if (!programFile(texts[k + 1] ?? "")) return true;
      k += 1;
      continue;
    }
    if (t.startsWith("--file=")) {
      if (!programFile(t.slice(7))) return true;
      continue;
    }
    if (t === "-l" || t === "--line-length") {
      k += 1;
      continue;
    }
    if (/^-[nrEsuz]*e./.test(t)) {
      scripts.push(t.slice(t.indexOf("e") + 1));
      continue;
    }
    if (/^-[nrEsuz]*f/.test(t)) {
      const glued = t.slice(t.indexOf("f") + 1);
      if (!programFile(glued || texts[k + 1] || "")) return true;
      if (!glued) k += 1;
    }
  }
  if (scripts.length === 0 && !fileScript) {
    const first = texts
      .slice(1)
      .find((t, idx) => !t.startsWith("-") && !/^-(?:l|-line-length)$/.test(texts[idx]));
    if (first !== undefined) scripts.push(first);
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
      if (!/^\/dev\/stdin$/.test(file))
        return `reads a file the hook cannot judge (${cmd} ${file.slice(0, 40)})`;
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

export { otherInterpreter, otherInterpreterName };
