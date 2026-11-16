/**
 * The inline-interpreter filesystem boundary: `python -c`, `node -e`, `ruby -e`,
 * `perl -e`, `php -r` and heredoc-fed programs, their write and read primitives.
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { resolve } from "node:path";
import { lexProgram } from "./inline-lex.mjs";
import { inlinePrograms } from "./inline-programs.mjs";
import { ENV_TEMPLATE, SECRET_PATH, canonicalize, classifyRootAccess } from "./paths.mjs";

// =====================================================================
// INLINE-INTERPRETER FILESYSTEM BOUNDARY (FG-007, P0/P1)
// ---------------------------------------------------------------------
// A Bash command can drive an inline interpreter program (`python3 -c …`,
// `node -e …`, `ruby -e …`, `perl -e …`, `php -r …`, or a heredoc fed to
// `python`/`node`/…) and that program can WRITE or READ files completely
// outside the file-tool path checks. Left unguarded this is a total bypass
// of the write-root boundary (the reviewer's P0): `node -e
// "fs.writeFileSync('<read-root>/x','y')"` was ALLOWED.
//
// We do NOT execute or fully parse the inline program. We scan its source
// text for the well-known WRITE primitives, pull out each LITERAL (quoted)
// path operand, and classify it against the write-roots:
//   • literal path in a read-root or outside all roots  → BLOCK.
//   • a write primitive is present but NO literal path can be confirmed
//     in a write-root (the destination is a variable / concatenation /
//     built at runtime)                                  → BLOCK (fail-closed).
// Rationale for fail-closed: the hook cannot prove a runtime-built path
// stays in-bounds, and this is the load-bearing security boundary — the
// agent should use the root-checked Write/Edit tools instead. An inline
// program with NO write primitive is not blocked by these rules.
//
// HONEST RESIDUAL LIMITATION: a fully-dynamic path (assembled at runtime,
// e.g. `p = os.environ['D'] + '/x'; open(p,'w')`) is exactly what trips the
// fail-closed rule here, so inline writes are now contained. The residual
// that this hook CANNOT distinguish — an in-bounds dynamic write from an
// out-of-bounds one — is conservatively denied; truly proving a runtime
// path needs an OS sandbox / seccomp-style filesystem jail, not a regex.
// =====================================================================

// Interpreter invocations that carry an INLINE program. We match the
// interpreter binary followed (anywhere on the line) by its inline-eval flag:
//   python/python3 -c            node/nodejs/deno/bun -e/--eval/-p/--print
//   ruby -e   perl -e/-E/-ne/-pe   php -r
// `node -p`/`--print` evaluates and prints an expression (can still write via
// a side-effecting call), so it is included. We capture the binary so the
// per-language primitive set can be selected.
const INLINE_EVAL_INVOCATION =
  /\b(python3?|node|nodejs|deno|bun|ruby|perl|php)\b[^\n]*?\s(?:-c|-e|-E|-ne|-pe|-r|-p|--eval|--print)\b/i;

// Heredoc-fed interpreters: `python <<'EOF' … EOF`, `node <<EOF … EOF`. The
// body between the delimiter lines is the inline program and is scanned the
// same way as a -c/-e program.
const HEREDOC_INTERPRETER =
  /\b(python3?|node|nodejs|deno|bun|ruby|perl|php)\b[^\n]*<<-?\s*["']?(\w+)["']?/i;

// WRITE-primitive detection is split into two concerns so a DYNAMIC path can
// still trip the fail-closed rule:
//   • PRESENCE patterns prove "this program writes a file" regardless of whether
//     the path argument is a literal or built at runtime.
//   • LITERAL-EXTRACTION patterns (one capture group = the quoted path) recover
//     the path WHEN it is a literal, so it can be classified against the roots.
// A write whose presence we detect but whose literal we CANNOT recover is a
// dynamic destination → fail-closed BLOCK (see inlineWriteBoundaryReason).
//
// PRESENCE patterns per interpreter family. Each matches the write call by name
// plus a write-indicator (mode flag / method), independent of the path form.
const PYTHON_WRITE_PRESENCE = [
  /\bopen\s*\([^)]*,\s*["'][^"']*[waxWAX+]/, // open(<anything>, 'w'|'a'|'x'|'r+')
  /\bopen\s*\([^,)]*,\s*[A-Za-z_][\w.]*\s*\)/, // open(<path>, mode_var) — mode is a var
  /\bPath\s*\([^)]*\)\s*\.\s*(?:write_text|write_bytes)\b/,
  /\bPath\s*\([^)]*\)\s*\.\s*open\s*\(\s*["'][^"']*[waxWAX+]/,
  /\bos\.open\s*\([^)]*O_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)\b/,
  /\bshutil\.(?:copy|copy2|copyfile|copytree|move)\s*\(/,
  // Shell-out from inside `python -c`: os.system / os.popen / subprocess.* spawn
  // a child whose filesystem effects we cannot see, let alone prove in-bounds.
  // Treat the shell-out as a write PRESENCE with no recoverable literal so the
  // inline-write boundary fails CLOSED (a runtime path can never be confirmed).
  // This is a conservative deny: shelling out from an inline interpreter is an
  // evasion shape, not a normal delivery action (run the command directly).
  /\bos\.(?:system|popen)\s*\(/,
  /\bsubprocess\.(?:run|call|check_call|check_output|Popen)\s*\(/,
];
const NODE_WRITE_PRESENCE = [
  /\b(?:fs\.)?(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(/,
  /\b(?:fs\.)?openSync\s*\([^)]*,\s*["'`][^"'`]*[waWA]/,
  /\b(?:fs\.)?(?:cpSync|copyFileSync|renameSync)\s*\(/,
];
const RUBY_WRITE_PRESENCE = [
  /\b(?:File|IO)\.(?:write|binwrite)\s*\(/,
  /\bFile\.(?:open|new)\s*\([^)]*,\s*["'][^"']*[waWA]/,
  // Paren-less calls (`File.write "p", "x"`, `File.open "p", "a" do …`) were missed.
  /\b(?:File|IO)\.(?:write|binwrite)\s/,
  /\bFile\.(?:open|new)\s[^,;]{0,1024},\s*["'][^"']*[waWA+]/,
  // …and the paren-less form whose path is one call (`File.open File.join(dir, "f"), "w"`):
  // the call's own comma ends the bounded scan above before the mode is reached. The call
  // is structured (a name / method chain, then one paren group) so it stays linear.
  /\bFile\.(?:open|new)\s+[\w.:]+\([^()\n]*\)\s*,\s*["'][^"']*[waWA+]/,
  /\b(?:FileUtils\.(?:cp|mv|copy|move)|File\.rename)\b/,
];
const PERL_WRITE_PRESENCE = [
  /\bopen\s*\([^,]*,\s*["']\+?>>?/, // open(FH, '>'|'>>', …) or open(FH, ">…")
  // The paren-less forms (open F, ">…" / open my $f, ">>", …). Bounded quantifiers keep
  // these linear on a 64 KiB adversarial input (an unbounded one is quadratic: ~1 s).
  /\bopen\s[^,;]{0,256},\s*["']\+?>>?/,
];
const PHP_WRITE_PRESENCE = [
  /\bfile_put_contents\s*\(/,
  /\bfopen\s*\([^)]*,\s*["'][^"']*[waxWAX+]/,
  /\b(?:copy|rename)\s*\(/,
];

// LITERAL-EXTRACTION patterns — capture group 1 is the quoted path literal.
const PYTHON_WRITE_LITERALS = [
  /\bopen\s*\(\s*(["'][^"']*["'])\s*,\s*["'][^"']*[waxWAX+][^"']*["']/,
  /\bPath\s*\(\s*(["'][^"']*["'])\s*\)\s*\.\s*(?:write_text|write_bytes)\b/,
  /\bPath\s*\(\s*(["'][^"']*["'])\s*\)\s*\.\s*open\s*\(\s*["'][^"']*[waxWAX+]/,
  /\bos\.open\s*\(\s*(["'][^"']*["'])[^)]*O_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)\b/,
  // shutil dest is the LAST string arg of a two-arg call.
  /\bshutil\.(?:copy|copy2|copyfile|copytree|move)\s*\([^,]*,\s*(["'][^"']*["'])\s*\)/,
];
const NODE_WRITE_LITERALS = [
  /\b(?:fs\.)?(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(\s*(["'`][^"'`]*["'`])/,
  /\b(?:fs\.)?openSync\s*\(\s*(["'`][^"'`]*["'`])\s*,\s*["'`][^"'`]*[waWA]/,
  /\b(?:fs\.)?(?:cpSync|copyFileSync|renameSync)\s*\([^,]*,\s*(["'`][^"'`]*["'`])\s*\)/,
];
const RUBY_WRITE_LITERALS = [
  /\b(?:File|IO)\.(?:write|binwrite)\s*\(\s*(["'][^"']*["'])/,
  /\bFile\.(?:open|new)\s*\(\s*(["'][^"']*["'])\s*,\s*["'][^"']*[waWA]/,
  /\b(?:File|IO)\.(?:write|binwrite)\s+(["'][^"']*["'])/,
  /\bFile\.(?:open|new)\s+(["'][^"']*["'])\s*,\s*["'][^"']*[waWA+]/,
];
const PERL_WRITE_LITERALS = [
  // 3-arg form: open(FH, '>'|'>>', 'path')  → capture the path (3rd arg).
  /\bopen\s*\([^,]*,\s*["']\+?>>?["']\s*,\s*(["'][^"']*["'])/,
  // 2-arg fused form: open(FH, ">path") — mode and path share one quoted
  // string. Capture the path WITHOUT the redirect prefix (no $ interpolation
  // → literal). We re-wrap in a sentinel quote so the shared stripQuotes/
  // classify path works; the leading >>? and any whitespace are dropped.
  /\bopen\s*\(\s*[^,]*,\s*["']\+?>>?\s*([^"'$>][^"'$]*)["']/,
  // …and both forms without parentheses: open my $f, '>', 'path' / open F, ">path".
  /\bopen\s[^,;]{0,256},\s*["']\+?>>?["']\s*,\s*(["'][^"']*["'])/,
  /\bopen\s[^,;]{0,256},\s*["']\+?>>?\s*([^"'$>][^"'$]*)["']/,
];
const PHP_WRITE_LITERALS = [
  /\bfile_put_contents\s*\(\s*(["'][^"']*["'])/,
  /\bfopen\s*\(\s*(["'][^"']*["'])\s*,\s*["'][^"']*[waxWAX+]/,
  /\b(?:copy|rename)\s*\([^,]*,\s*(["'][^"']*["'])\s*\)/,
];

/** Select {presence, literals} primitive sets for an interpreter binary name. */
function writePrimitivesFor(bin) {
  const b = bin.toLowerCase();
  if (b.startsWith("python"))
    return { presence: PYTHON_WRITE_PRESENCE, literals: PYTHON_WRITE_LITERALS };
  if (b === "node" || b === "nodejs" || b === "deno" || b === "bun")
    return { presence: NODE_WRITE_PRESENCE, literals: NODE_WRITE_LITERALS };
  if (b === "ruby") return { presence: RUBY_WRITE_PRESENCE, literals: RUBY_WRITE_LITERALS };
  if (b === "perl") return { presence: PERL_WRITE_PRESENCE, literals: PERL_WRITE_LITERALS };
  if (b === "php") return { presence: PHP_WRITE_PRESENCE, literals: PHP_WRITE_LITERALS };
  // Unknown interpreter: union everything so we never miss a write primitive.
  return {
    presence: [
      ...PYTHON_WRITE_PRESENCE,
      ...NODE_WRITE_PRESENCE,
      ...RUBY_WRITE_PRESENCE,
      ...PERL_WRITE_PRESENCE,
      ...PHP_WRITE_PRESENCE,
    ],
    literals: [
      ...PYTHON_WRITE_LITERALS,
      ...NODE_WRITE_LITERALS,
      ...RUBY_WRITE_LITERALS,
      ...PERL_WRITE_LITERALS,
      ...PHP_WRITE_LITERALS,
    ],
  };
}

// FILE-READ primitives per interpreter family, each capturing the literal
// path argument. Used for P1 (block a confirmed-outside-roots literal read);
// reads are NOT fail-closed (a dynamic read path is left to the secret guard).
const READ_PRIMITIVE_PATTERNS = [
  // python: open(<path>) [no write mode], Path(<path>).read_text/read_bytes
  /\bopen\s*\(\s*(["'][^"']*["'])\s*\)/,
  /\bopen\s*\(\s*(["'][^"']*["'])\s*,\s*["'][^"']*r[^"']*["']\s*\)/,
  /\bPath\s*\(\s*(["'][^"']*["'])\s*\)\s*\.\s*read_(?:text|bytes)\b/,
  // node: fs.readFileSync/readFile/createReadStream(<path>)
  /\b(?:fs\.)?(?:readFileSync|readFile|createReadStream)\s*\(\s*(["'`][^"'`]*["'`])/,
  // ruby: File.read/IO.read/File.readlines(<path>), File.open(<path>) read-ish
  /\b(?:File|IO)\.(?:read|readlines|binread)\s*\(\s*(["'][^"']*["'])/,
  // perl: open(FH, '<', <path>) or 2-arg read open(FH, "<$path") with literal
  /\bopen\s*\([^,]*,\s*["']<["']\s*,\s*(["'][^"']*["'])/,
  /\bopen\s*\([^,]*,\s*["']<\s*(["'][^"']*["'])/,
  // php: file_get_contents(<path>) / fopen(<path>, 'r')
  /\bfile_get_contents\s*\(\s*(["'][^"']*["'])/,
];

/**
 * Pull the inline-program source out of a Bash command: the argument(s) after
 * a -c/-e/--eval flag (best-effort — we take the rest of the segment), plus any
 * heredoc body. We don't try to perfectly tokenise the shell; we want the
 * literal program text so the primitive regexes can run against it.
 */
function extractInlinePrograms(cmd) {
  const programs = [];
  // -c/-e/--eval/… : capture everything after the flag on that line. The shell
  // quoting is irrelevant for our literal-path scan — primitives and their
  // quoted path args survive intact in the raw text.
  for (const m of cmd.matchAll(
    /\b(?:python3?|node|nodejs|deno|bun|ruby|perl|php)\b[^\n]*?\s(?:-c|-e|-E|-ne|-pe|-r|-p|--eval|--print)\b(.*)$/gim,
  )) {
    if (m[1]) programs.push(m[1]);
  }
  // Heredoc bodies.
  for (const m of cmd.matchAll(
    /\b(?:python3?|node|nodejs|deno|bun|ruby|perl|php)\b[^\n]*<<-?\s*["']?(\w+)["']?\n([\s\S]*?)\n[ \t]*\1\b/gi,
  )) {
    if (m[2]) programs.push(m[2]);
  }
  return programs;
}

/** The interpreter binary names present in the command (lowercased). */
function inlineInterpreterBins(cmd) {
  const bins = new Set();
  for (const m of cmd.matchAll(/\b(python3?|node|nodejs|deno|bun|ruby|perl|php)\b/gi)) {
    bins.add(m[1].toLowerCase());
  }
  return [...bins];
}

/**
 * Strip the surrounding quote characters from a captured literal path token
 * (handles ", ', and ` from the primitive captures).
 */
function stripQuotes(literal) {
  return literal.replace(/^["'`]|["'`]$/g, "");
}

/**
 * Enforce the write-root boundary for inline-interpreter WRITE primitives.
 * Returns a block reason string, or null when nothing to enforce.
 *
 * Algorithm, biased to DENY:
 *   1. Find every write primitive across all inline programs / heredocs.
 *   2. For each, extract the LITERAL path argument if present:
 *        • literal not in a write-root (read-root or outside) → BLOCK now.
 *   3. If a write primitive is present but we could NOT confirm at least one
 *      literal path that lands in a write-root → BLOCK (fail-closed): the
 *      destination is dynamic and the hook can't prove it stays in-bounds.
 */
function inlineWriteBoundaryReason(cmd, roots) {
  if (!INLINE_EVAL_INVOCATION.test(cmd) && !HEREDOC_INTERPRETER.test(cmd)) return null;
  const programs = extractInlinePrograms(cmd);
  if (programs.length === 0) {
    // A heredoc-fed interpreter was invoked (`python <<EOF …`) but the parser
    // could not recover the body — the terminator the regex needs to bound the
    // heredoc isn't where it expects it (e.g. an indented/mismatched/dynamic
    // terminator). We CANNOT scan a body we couldn't extract, so the inline-write
    // boundary would never fire and the write would slip through silently. Treat
    // this exactly like a write whose destination we can't prove: FAIL CLOSED.
    if (HEREDOC_INTERPRETER.test(cmd)) {
      return "heredoc-fed interpreter whose body could not be parsed (unresolved terminator) — its filesystem writes cannot be proven to stay inside the write-roots; use the Write/Edit tools, which are root-checked";
    }
    return null;
  }
  const bins = inlineInterpreterBins(cmd);
  // Union of the primitive sets for whatever interpreters appear. (When the
  // exact binary→program pairing is ambiguous we over-scan; that only ADDS
  // denials, never removes one.)
  const sets = bins.length ? bins.map(writePrimitivesFor) : [writePrimitivesFor("")];
  const presence = [...new Set(sets.flatMap((s) => s.presence))];
  const literals = [...new Set(sets.flatMap((s) => s.literals))];

  const matchAllGlobal = (program, re) => {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    return [...program.matchAll(g)];
  };

  let sawWritePrimitive = false;
  let confirmedInWriteRoot = false;
  for (const program of programs) {
    // (1) Presence: does this program write a file at all?
    const writesHere = presence.some((re) => re.test(program));
    if (!writesHere) continue;
    sawWritePrimitive = true;

    // (2) Recover every LITERAL destination and classify it. Any literal that
    //     is not in a write-root is an immediate BLOCK.
    for (const re of literals) {
      for (const m of matchAllGlobal(program, re)) {
        const literal = m[1];
        if (!literal) continue;
        const raw = stripQuotes(literal);
        // A path with shell/interpreter interpolation is not a provable literal.
        if (!raw || /[$`]|\$\{|#\{/.test(raw)) continue;
        const abs = canonicalize(resolve(process.cwd(), raw));
        const access = classifyRootAccess(abs, roots);
        if (access !== "write") {
          return `inline interpreter writes outside write-roots (target is ${
            access === "read" ? "in a read-only root" : "outside all roots"
          }): ${raw} [write-roots: ${roots.writeRoots.join(", ")}]`;
        }
        confirmedInWriteRoot = true;
      }
    }
  }
  if (sawWritePrimitive && !confirmedInWriteRoot) {
    // FAIL-CLOSED: a write happens but no literal in-write-root destination was
    // provable (path is a variable / concatenation / built at runtime). The
    // hook can't prove it stays in-bounds — deny and steer to the root-checked
    // Write/Edit tools. (This is the residual that an OS sandbox would own.)
    return "inline interpreter performs a filesystem write whose destination cannot be proven to stay inside the write-roots (dynamic/runtime path) — use the Write/Edit tools, which are root-checked";
  }
  return null;
}

/**
 * Enforce the read-root boundary for inline-interpreter FILE READS (P1).
 * Returns a block reason for a CONFIRMED-outside literal read target, or null.
 * Reads are NOT fail-closed here (dynamic reads are too noisy to deny en masse
 * and the secret-path guard already covers the high-value case); the residual
 * is a dynamic read path, documented honestly.
 */
function inlineReadBoundaryReason(cmd, roots) {
  if (!INLINE_EVAL_INVOCATION.test(cmd) && !HEREDOC_INTERPRETER.test(cmd)) return null;
  const programs = extractInlinePrograms(cmd);
  for (const program of programs) {
    for (const re of READ_PRIMITIVE_PATTERNS) {
      const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      for (const m of program.matchAll(global)) {
        const literal = m[1];
        if (!literal) continue;
        const raw = stripQuotes(literal);
        if (!raw || /[$`]|\$\{|#\{/.test(raw)) continue;
        const abs = canonicalize(resolve(process.cwd(), raw));
        if (classifyRootAccess(abs, roots) === "outside") {
          return `inline interpreter reads a file outside allowed roots: ${raw} [write-roots: ${roots.writeRoots.join(
            ", ",
          )}; read-roots: ${roots.readRoots.join(", ")}]`;
        }
      }
    }
  }
  return null;
}

// =====================================================================
// INLINE PROGRAMS: CAPABILITIES, NOT CALL SPELLINGS (63C)
// ---------------------------------------------------------------------
// The write primitives above are a list of spellings, and a list loses to the next
// spelling: `os.open(p, 65)`, `open(p, mode="a")`, `f.writeSync(f.openSync(p, 1))`, a
// double-quoted program with escaped quotes all passed it. With no OS sandbox that is a
// write anywhere the operator can write.
//
// So an inline program is now judged by what it CAN do, read off its normalised text:
//   - the text is the program the interpreter receives (lib/hook/inline-programs.mjs
//     undoes the shell's quoting, follows wrappers, xargs, sh -c, eval, heredocs and
//     stdin, and refuses what it cannot see);
//   - it is lexed per language (lib/hook/inline-lex.mjs): strings decoded, comments
//     dropped, interpolated code read as code;
//   - any capability to write or delete files, start a process, reach the network or
//     run code built at run time refuses the program, whatever its alias or spelling:
//     an import of a capability module under any name, a member of a restricted module
//     (os, sys, fs, process, File, ...) outside its read-only list, a dynamic escape
//     (eval, exec, getattr, __import__, dunders, Function, constructor, computed
//     members, send, string callables, ...);
//   - the one capability allowed is a write (or delete, rename, mkdir) whose every path
//     is a literal inside a write root, where the program runs (`cd` followed);
//   - a capability word inside a string or comment refuses too: the lexer could be
//     wrong about where text ends, and the word may be code.
// Reads keep their own rules (the read boundary above, reads.mjs); a program with no
// capability word passes. What this cannot see is a file the program runs: a script
// the agent wrote (`python x.py`), a local module it imports, `-m module`, `-r`
// preloads. That is the documented residual (SECURITY.md); containment is the OS
// sandbox's job.
// =====================================================================

const ADVICE =
  "it cannot be proven to stay inside the write roots. Use the Write/Edit tools for files, or put the program in a file inside the worktree and run it";

const cap = (caps, why) => caps.push(why);
const MAX_INLINE_WRITE_TARGETS = 64;

// Brackets: match[i] is the index of the token closing the bracket at i.
function matchBrackets(toks) {
  const match = new Int32Array(toks.length).fill(-1);
  const stack = [];
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.t !== "p") continue;
    if (t.v === "(" || t.v === "[" || t.v === "{") stack.push(i);
    else if (t.v === ")" || t.v === "]" || t.v === "}") {
      const open = stack.pop();
      if (open !== undefined) {
        match[open] = i;
        match[i] = open;
      }
    }
  }
  return match;
}

// The argument ranges [a, b) of the call whose `(` is at `open`.
function callArgs(toks, open, match) {
  const close = match[open];
  if (close < 0) return [];
  const args = [];
  let a = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const t = toks[i];
    if (t.t === "p" && (t.v === "(" || t.v === "[" || t.v === "{") && match[i] > i) {
      i = match[i];
      continue;
    }
    if (t.t === "p" && t.v === ",") {
      args.push([a, i]);
      a = i + 1;
    }
  }
  if (close > a) args.push([a, close]);
  return args;
}

// The value of a plain string literal spanning exactly [a, b), or null.
function literalAt(toks, a, b) {
  if (b - a !== 1) return null;
  const t = toks[a];
  if (t.t !== "str" || t.interp || t.command || !t.exact || t.kind === "regex") return null;
  return t.v;
}

// Keyword argument `name=` at the start of an argument range (Python).
function kwName(toks, a, b) {
  if (b - a >= 2 && toks[a].t === "id" && toks[a + 1].t === "p" && toks[a + 1].v === "=") {
    return toks[a].v;
  }
  return null;
}

const isP = (t, v) => Boolean(t) && t.t === "p" && t.v === v;
const isDot = (t) => Boolean(t) && t.t === "p" && (t.v === "." || t.v === "?.");

// Classify each literal path of a write against the write roots where the program runs.
function writePathsReason(paths, cwd, roots, what, targets = []) {
  for (const raw of paths) {
    if (typeof raw !== "string" || raw === "" || /[$`]|#\{/.test(raw)) {
      return `writes through ${what} to a path that is not a plain literal`;
    }
    if (!raw.startsWith("/") && cwd === null) {
      return `writes through ${what} to a relative path after a directory change the hook cannot follow`;
    }
    let abs;
    try {
      abs = canonicalize(resolve(cwd ?? "/", raw));
    } catch {
      return `writes through ${what} to a path too deep to resolve`;
    }
    const access = classifyRootAccess(abs, roots);
    if (access !== "write") {
      return `writes through ${what} to ${raw}, which is ${access === "read" ? "in a read-only root" : "outside the write roots"}`;
    }
    targets.push(abs);
  }
  return null;
}

// ---------------------------------------------------------------------
// The capability words found inside text (strings, comments): a lexer can be wrong
// about where text ends, so these spellings refuse there too. Shapes: "any" (the word),
// "call" (the word, then `(`), "dot" (the word, then `.`).
// ---------------------------------------------------------------------
const TEXT_WORDS = {
  python: {
    any: "subprocess popen spawnv spawnve spawnl execv execve execvp execvpe execl execlp fork forkpty ctypes socket urlopen shutil tempfile importlib __import__ __builtins__ __subclasses__ __globals__ write_text write_bytes fdopen symlink unlink rmtree mkfifo breakpoint pickle marshal",
    call: "system eval exec compile getattr setattr open",
  },
  js: {
    any: "child_process execSync execFileSync spawnSync writeFileSync appendFileSync createWriteStream writeSync openSync copyFileSync cpSync renameSync rmSync unlinkSync mkdirSync symlinkSync chmodSync worker_threads dlopen mainModule getBuiltinModule __proto__ globalThis",
    call: "eval Function require import spawn execFile fork binding chdir fetch",
  },
  ruby: {
    any: "popen popen3 Open3 PTY Socket TCPSocket FileUtils Fiddle Marshal instance_eval class_eval module_eval instance_exec __send__ public_send syscall",
    call: "system exec spawn fork eval send open",
    dot: "IO Kernel Process File Dir",
  },
  perl: {
    any: "system exec qx readpipe syscall sysopen fork socket symlink unlink",
    call: "open eval do require rename chmod kill",
  },
  php: {
    any: "shell_exec passthru proc_open pcntl_exec create_function file_put_contents fsockopen curl_exec call_user_func call_user_func_array",
    call: "system exec popen eval assert fopen unlink rename copy mkdir chmod symlink mail putenv include require",
  },
};
const TEXT_SETS = {};
for (const [lang, groups] of Object.entries(TEXT_WORDS)) {
  TEXT_SETS[lang] = {};
  for (const [shape, words] of Object.entries(groups)) {
    TEXT_SETS[lang][shape] = new Set(words.split(" "));
  }
}

function textWordReason(lang, src, mask) {
  const sets = TEXT_SETS[lang];
  for (const m of src.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (!mask[m.index]) continue;
    const w = m[0];
    const after = src.slice(m.index + w.length, m.index + w.length + 8).replace(/^[ \t]+/, "");
    if (
      sets.any?.has(w) ||
      (sets.call?.has(w) && after.startsWith("(")) ||
      (sets.dot?.has(w) && after.startsWith("."))
    ) {
      return `has the capability word ${w} where the hook reads text (a string or comment), and cannot tell it from code`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// PYTHON
// ---------------------------------------------------------------------
const PY_SAFE_MODULES = new Set(
  (
    "json re math cmath datetime time collections itertools functools operator string textwrap " +
    "statistics decimal fractions random secrets hashlib hmac base64 binascii uuid pprint enum " +
    "dataclasses typing numbers copy heapq bisect array struct unicodedata html calendar shlex " +
    "difflib fnmatch glob csv zlib platform keyword abc contextlib tomllib getpass pwd " +
    "grp locale gettext warnings traceback colorsys ipaddress graphlib zoneinfo filecmp " +
    "linecache token tokenize sysconfig __future__ packaging tomli this pathlib"
  ).split(" "),
);
// Modules with a read-only member list (anything else of theirs is a capability).
const PY_RESTRICTED = {
  os: new Set(
    (
      "environ environb getenv getenvb getcwd getcwdb listdir scandir walk stat lstat fstat path " +
      "sep linesep pathsep name cpu_count process_cpu_count getpid getppid getuid getgid geteuid " +
      "getegid getgroups getlogin uname urandom get_terminal_size terminal_size devnull curdir " +
      "pardir extsep altsep fspath fsencode fsdecode access isatty times getloadavg strerror " +
      "sysconf confstr get_exec_path O_RDONLY F_OK R_OK W_OK X_OK readlink read close stat_result " +
      "DirEntry PathLike error SEEK_SET SEEK_CUR SEEK_END sched_getaffinity"
    ).split(" "),
  ),
  io: new Set(
    "StringIO BytesIO TextIOWrapper BufferedReader IOBase TextIOBase SEEK_SET SEEK_CUR SEEK_END DEFAULT_BUFFER_SIZE UnsupportedOperation text_encoding".split(
      " ",
    ),
  ),
  codecs: new Set(
    "decode encode lookup getreader getwriter getincrementaldecoder getincrementalencoder iterdecode iterencode BOM BOM_UTF8 BOM_UTF16 BOM_UTF16_LE BOM_UTF16_BE BOM_UTF32 utf_8_decode utf_8_encode".split(
      " ",
    ),
  ),
  yaml: new Set(
    "safe_load safe_load_all safe_dump safe_dump_all dump dump_all YAMLError SafeLoader CSafeLoader SafeDumper __version__ __file__".split(
      " ",
    ),
  ),
  importlib: new Set(["metadata"]),
  urllib: new Set(["parse"]),
};
const PY_VERSION_ONLY = {
  sqlite3: new Set(["sqlite_version", "sqlite_version_info", "version", "version_info"]),
  ssl: new Set([
    "OPENSSL_VERSION",
    "OPENSSL_VERSION_INFO",
    "OPENSSL_VERSION_NUMBER",
    "HAS_SNI",
    "HAS_ALPN",
    "HAS_TLSv1_3",
  ]),
};
const PY_SITE_READ = new Set(
  "getsitepackages getusersitepackages getuserbase ENABLE_USER_SITE USER_SITE USER_BASE PREFIXES".split(
    " ",
  ),
);
const PY_SYS_DENY = new Set(
  "modules meta_path path_hooks path_importer_cache settrace setprofile call_tracing breakpointhook remote_exec addaudithook".split(
    " ",
  ),
);
// os members that may write when every path is a literal in a write root: name -> path args.
const PY_OS_WRITES = {
  remove: 1,
  unlink: 1,
  rmdir: 1,
  mkdir: 1,
  makedirs: 1,
  removedirs: 1,
  truncate: 1,
  chmod: 1,
  utime: 1,
  open: 1,
  rename: 2,
  replace: 2,
  renames: 2,
  symlink: 2,
  link: 2,
};
// pathlib methods that write: name -> number of path arguments besides the receiver.
const PY_PATH_WRITES = {
  write_text: 0,
  write_bytes: 0,
  touch: 0,
  unlink: 0,
  mkdir: 0,
  rmdir: 0,
  chmod: 0,
  lchmod: 0,
  rename: 1,
  replace: 1,
  symlink_to: 1,
  hardlink_to: 1,
  link_to: 1,
  copy: 1,
  move: 1,
  copy_into: 1,
  move_into: 1,
};
const PY_DYNAMIC_BUILTINS = new Set(
  "eval exec compile __import__ getattr setattr delattr globals locals vars breakpoint help".split(
    " ",
  ),
);
const PY_SAFE_DUNDERS = new Set(
  (
    "__name__ __main__ __file__ __doc__ __version__ __future__ __init__ __str__ __repr__ __len__ " +
    "__iter__ __next__ __eq__ __ne__ __lt__ __le__ __gt__ __ge__ __hash__ __enter__ __exit__ " +
    "__getitem__ __contains__ __add__ __sub__ __mul__ __bool__ __all__ __slots__ __qualname__"
  ).split(" "),
);
const PY_DANGER_ATTRS = new Set(
  (
    "system popen popen2 popen3 spawnl spawnle spawnlp spawnlpe spawnv spawnve spawnvp spawnvpe " +
    "posix_spawn posix_spawnp execl execle execlp execlpe execv execve execvp execvpe fork " +
    "forkpty vfork kill killpg fdopen modules f_globals f_locals f_builtins f_back gi_frame " +
    "cr_frame ag_frame tb_frame gi_code co_code os sys subprocess shutil socket ctypes posix nt " +
    "importlib builtins pty mmap tempfile pickle marshal startfile chroot setuid seteuid setgid " +
    "mkfifo mknod removedirs renames ftruncate fchmod lchown fchown makedirs symlink link " +
    "truncate utime remove copyfile copytree copy2 rmtree chown chdir fchdir attrgetter " +
    "methodcaller get_field vformat " +
    // The dynamic builtins reached as attributes (`enum.bltns.exec`, `builtins` under any
    // module's alias), and functions that evaluate annotation strings as code.
    "bltns exec eval getattr setattr delattr globals locals vars breakpoint help " +
    "get_type_hints ForwardRef evaluate_forward_ref get_annotations singledispatch " +
    "singledispatchmethod " +
    // What a module reached through another one offers under a generic name.
    "write_history_file append_history_file interact InteractiveConsole " +
    "InteractiveInterpreter compile_command runctx runcall"
  ).split(" "),
);
// The save methods of common packages (numpy, pandas, matplotlib, PIL, polars, ...): a
// package's surface is not modelled, so these spellings at least need a literal path.
const PY_SAVE_METHODS = new Set(
  (
    "save savetxt savez savez_compressed tofile to_csv to_json to_excel to_parquet to_pickle " +
    "to_feather to_hdf to_html to_latex to_markdown to_sql to_stata to_xml to_orc savefig " +
    "imsave imwrite write_csv write_json write_parquet write_ipc write_excel to_file dump_file"
  ).split(" "),
);
const PY_SAFE_PRIVATE = new Set(["_asdict", "_fields", "_replace", "_make", "_field_defaults"]);
const VERSION_ATTRS = new Set(
  "__version__ VERSION version version_info get_version __file__ __path__ __name__ __doc__".split(
    " ",
  ),
);
// Modules that ARE a capability, named so a local file of that name never makes them safe.
const PY_CAP_MODULES = new Set(
  (
    "subprocess shutil tempfile socket socketserver ssl http ftplib smtplib poplib imaplib " +
    "telnetlib xmlrpc asyncio selectors select multiprocessing concurrent ctypes cffi mmap pty " +
    "tty termios fcntl resource posix nt pickle cPickle dill marshal shelve dbm sqlite3 zipfile " +
    "tarfile gzip bz2 lzma zipimport pkgutil runpy code codeop timeit trace pdb bdb profile " +
    "cProfile doctest unittest pydoc builtins __builtin__ imp types inspect gc webbrowser logging " +
    "fileinput mailbox wave aifc sunau venv ensurepip distutils setuptools pip site requests " +
    "httpx aiohttp urllib3 paramiko fabric invoke sh plumbum pexpect psutil docker boto3 " +
    "botocore wsgiref signal threading _thread argparse netrc pipes py_compile compileall " +
    "smtpd uu xml zipapp asynchat asyncore cgitb readline syslog tracemalloc pstats idlelib " +
    "copyreg turtle tkinter nntplib faulthandler ossaudiodev spwd antigravity lib2to3 " +
    "turtledemo cgi annotationlib"
  ).split(" "),
);
// Capability modules that may be reached as an attribute of another module
// (`tokenize.io`, `importlib.metadata.zipfile`, `email.utils.socket`): every name above
// but the few that are also common attribute names of plain objects (`sys.stdin.readline`,
// `err.code`), whose dangerous members are named in PY_DANGER_ATTRS instead.
const PY_CHAIN_CAP = new Set(
  [...PY_CAP_MODULES].filter(
    (m) => !["readline", "code", "select", "signal", "trace", "profile", "resource"].includes(m),
  ),
);
// Bare names that evaluate strings as code (after `from typing import *`).
const PY_DANGER_BARE = new Set(
  "get_type_hints ForwardRef evaluate_forward_ref get_annotations singledispatch singledispatchmethod bltns".split(
    " ",
  ),
);

function pyModulePolicy(dotted) {
  const top = dotted.split(".")[0];
  if (top.startsWith("_") && top !== "__future__") return { cap: true };
  // site's readers; its addsitedir() runs .pth files.
  if (dotted === "site") return { allow: PY_SITE_READ, mod: "site" };
  // Version fields of capability modules (`sqlite3.sqlite_version`, `ssl.OPENSSL_VERSION`):
  // only those members pass, so `connect` or `wrap_socket` is still refused.
  if (dotted === top && PY_VERSION_ONLY[top]) return { allow: PY_VERSION_ONLY[top], mod: top };
  if (PY_CAP_MODULES.has(top)) return { cap: true };
  // json.tool's main() writes the file named by sys.argv.
  if (dotted === "json.tool" || dotted.startsWith("json.tool.")) return { cap: true };
  // `from urllib.parse import urlparse` and `from os.path import join` name members of
  // the safe submodules (`urllib.parse.urlparse`), not other submodules.
  const under = (m) => dotted === m || dotted.startsWith(m + ".");
  if (dotted.startsWith("urllib.") && !under("urllib.parse")) return { cap: true };
  if (dotted.startsWith("importlib.") && !under("importlib.metadata")) {
    return { cap: true };
  }
  if (dotted.startsWith("os.") && !under("os.path")) return { cap: true };

  if (under("os.path") || under("urllib.parse") || under("importlib.metadata")) {
    return { safe: true };
  }
  if (top === "sys") return { sys: true };
  if (PY_RESTRICTED[top]) return { allow: PY_RESTRICTED[top], mod: top };
  if (PY_SAFE_MODULES.has(top)) return { safe: true };
  // Any other module: a package or a local module. Its code is as invisible as a script
  // file (the residual); what the program does with it is still read here.
  return { safe: true, unknown: true };
}

function pyMemberWhy(policy, member, modName) {
  if (policy.safe) return null;
  if (policy.cap) return `uses ${modName}`;
  if (policy.sys) {
    return member.startsWith("_") || PY_SYS_DENY.has(member) ? `uses sys.${member}` : null;
  }
  if (policy.allow.has(member)) return null;
  return `uses ${modName}.${member}`;
}

function statementStart(toks, i) {
  if (i === 0 || toks[i].nl) return true;
  const p = toks[i - 1];
  return p.t === "p" && (p.v === ";" || p.v === ":");
}

function analysePython(toks, prog, roots, caps, writes) {
  const match = matchBrackets(toks);
  const bindings = new Map(); // name -> { policy, mod, member? }
  const skip = new Uint8Array(toks.length);
  // Imports.
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.t !== "id" || (t.v !== "import" && t.v !== "from") || !statementStart(toks, i)) continue;
    let j = i;
    const dotted = () => {
      let name = "";
      while (isP(toks[j], ".")) {
        name += "."; // a relative import: `from . import x`, `from ..a import b`
        j += 1;
      }
      if (toks[j]?.t !== "id" || toks[j].v === "import") return name;
      name += toks[j].v;
      j += 1;
      while (isP(toks[j], ".") && toks[j + 1]?.t === "id") {
        name += "." + toks[j + 1].v;
        j += 2;
      }
      return name;
    };
    if (t.v === "import") {
      j = i + 1;
      for (;;) {
        const name = dotted();
        if (!name) break;
        let bound = name.split(".")[0];
        let mod = bound;
        if (toks[j]?.t === "id" && toks[j].v === "as") {
          bound = toks[j + 1]?.v ?? "";
          mod = name;
          j += 2;
        }
        const policy = pyModulePolicy(mod);
        if (policy.cap) cap(caps, `imports ${name}`);
        bindings.set(bound, { policy, mod });
        if (!isP(toks[j], ",")) break;
        j += 1;
      }
    } else {
      j = i + 1;
      const name = dotted();
      if (toks[j]?.t !== "id" || toks[j].v !== "import") {
        skip[i] = 1;
        continue;
      }
      j += 1;
      const policy = pyModulePolicy(name);
      if (policy.cap) cap(caps, `imports from ${name}`);
      if (name.startsWith(".")) cap(caps, "imports relative to a package");
      if (isP(toks[j], "(")) j += 1;
      if (isP(toks[j], "*")) {
        if (!policy.safe) cap(caps, `imports * from ${name}`);
        j += 1;
      }
      while (toks[j]?.t === "id") {
        const member = toks[j].v;
        let bound = member;
        j += 1;
        if (toks[j]?.t === "id" && toks[j].v === "as") {
          bound = toks[j + 1]?.v ?? "";
          j += 2;
        }
        const sub = `${name}.${member}`;
        if (PY_DANGER_ATTRS.has(member) || PY_DYNAMIC_BUILTINS.has(member)) {
          cap(caps, `imports ${member} from ${name}`);
        }
        const subPolicy = pyModulePolicy(sub);
        const why = subPolicy.cap ? `imports ${sub}` : pyMemberWhy(policy, member, name);
        if (why) cap(caps, why);
        // `from tokenize import io`: a module imported from another keeps its own policy.
        if (PY_CHAIN_CAP.has(member)) cap(caps, `imports the module ${member} from ${name}`);
        if (PY_RESTRICTED[member] && member !== "importlib" && member !== "urllib") {
          bindings.set(bound, { policy: pyModulePolicy(member), mod: member });
        } else bindings.set(bound, { policy: { safe: true }, mod: sub, member });
        if (isP(toks[j], ",")) j += 1;
      }
    }
    for (let k = i; k < j; k += 1) skip[k] = 1;
  }
  for (let i = 0; i < toks.length; i += 1) {
    if (skip[i]) continue;
    const t = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (t.t === "str" && t.command) cap(caps, "runs a command");
    if (t.t === "str" && /__\w+__/.test(t.v)) {
      // `"{0.__class__}".format(x)`, Formatter().get_field("0.__globals__"): a dunder by name.
      for (const m of t.v.matchAll(/__\w+?__/g)) {
        if (!PY_SAFE_DUNDERS.has(m[0])) cap(caps, `names ${m[0]} in a string`);
      }
    }
    if (t.t !== "id") continue;
    const attr = isDot(prev);
    const name = t.v;
    if (/^__\w+__$/.test(name) && !PY_SAFE_DUNDERS.has(name)) {
      cap(caps, `reaches ${name}`);
      continue;
    }
    if (attr) {
      if (name.startsWith("_") && !/^__\w+__$/.test(name) && !PY_SAFE_PRIVATE.has(name)) {
        cap(caps, `reaches the private member .${name}`);
        continue;
      }
      pyAttribute(toks, i, match, bindings, prog, roots, caps, writes);
      continue;
    }
    // A keyword argument name (`f(eval=1)`) is not the builtin.
    if (isP(next, "=") && (isP(prev, "(") || isP(prev, ","))) continue;
    if (PY_DANGER_BARE.has(name)) {
      cap(caps, `uses ${name}, which evaluates strings as code`);
      continue;
    }
    if ((name === "environ" || name === "environb") && bindings.get(name)?.member) {
      const why = pyEnvironWhy(toks, i, match);
      if (why) cap(caps, why);
      continue;
    }
    if (PY_DYNAMIC_BUILTINS.has(name)) {
      cap(caps, `runs code built at run time (${name})`);
      continue;
    }
    if (name === "open" && !bindings.has("open")) {
      pyOpen(toks, i, match, prog, roots, caps, writes, "open");
      continue;
    }
    const b = bindings.get(name);
    if (b && !b.member && !b.policy.safe) {
      if (!isDot(next) || toks[i + 2]?.t !== "id") {
        cap(caps, `uses the module ${b.mod} in a way the hook cannot follow`);
        continue;
      }
      const member = toks[i + 2].v;
      if (b.policy.allow === PY_RESTRICTED.os && PY_OS_WRITES[member] !== undefined) {
        // os.remove("x"), os.rename("a", "b"), os.open("x", flags): literal paths only.
        if (!isP(toks[i + 3], "(")) {
          cap(caps, `uses os.${member} in a way the hook cannot follow`);
          continue;
        }
        const args = callArgs(toks, i + 3, match);
        const paths = args.slice(0, PY_OS_WRITES[member]).map(([a, z]) => literalAt(toks, a, z));
        if (paths.length < PY_OS_WRITES[member] || paths.some((p) => p === null)) {
          cap(caps, `writes through os.${member} to a path that is not a plain literal`);
        } else writes.push({ paths, what: `os.${member}` });
        skip[i + 2] = 1;
        continue;
      }
      const why = pyMemberWhy(b.policy, member, b.mod);
      if (why) cap(caps, why);
      if (
        !why &&
        b.policy.allow === PY_RESTRICTED.os &&
        (member === "environ" || member === "environb")
      ) {
        const envWhy = pyEnvironWhy(toks, i + 2, match);
        if (envWhy) cap(caps, envWhy);
      }
      skip[i + 2] = 1;
    }
  }
  // PYTHONINSPECT in the environment at exit makes python read a program from stdin.
  if (prog.text.includes("PYTHONINSPECT"))
    cap(caps, "names PYTHONINSPECT (interactive mode at exit)");
}

const PY_ENVIRON_READS = new Set(["get", "copy", "items", "keys", "values"]);
const PY_ENVIRON_TAKERS = new Set([
  "dict",
  "print",
  "len",
  "sorted",
  "list",
  "str",
  "repr",
  "set",
  "tuple",
]);

// An assignment operator at k: `=`, `+=`, `|=`, `//=`, ... (not `==`).
function pyAssignAt(toks, k) {
  const t = toks[k];
  if (isP(t, "=") || isP(t, "+=") || isP(t, "-=")) return true;
  if (!t || t.t !== "p" || !/^(?:[*/%&|^@<>]|\*\*|<<|>>)$/.test(t.v)) return false;
  let n = k + 1;
  if (isP(toks[n], "/") && t.v === "/" && toks[n].s === t.e) n += 1;
  return isP(toks[n], "=") && toks[n].s === toks[n - 1].e;
}

// Why the use of os.environ at j changes the environment (or hands it to code that can),
// or null for a read. In the environment PYTHONINSPECT turns a finished program into an
// interactive one reading stdin.
function pyEnvironWhy(toks, j, match) {
  const next = toks[j + 1];
  const del = toks[j - 1]?.v === "del" || (isDot(toks[j - 1]) && toks[j - 3]?.v === "del");
  if (del) return "deletes from os.environ";
  if (isDot(next)) {
    return toks[j + 2]?.t === "id" && PY_ENVIRON_READS.has(toks[j + 2].v)
      ? null
      : `changes os.environ (.${toks[j + 2]?.v ?? "?"})`;
  }
  if (isP(next, "[")) {
    const close = match[j + 1];
    if (close < 0 || pyAssignAt(toks, close + 1)) return "assigns into os.environ";
    return null;
  }
  if (pyAssignAt(toks, j + 1)) return "assigns to os.environ";
  // The base of a dotted name `os.environ`: the token before the dot-chain start.
  let base = j;
  if (isDot(toks[j - 1]) && toks[j - 2]?.t === "id") base = j - 2;
  const before = toks[base - 1];
  if (
    isP(before, "=") ||
    (isP(before, "=") === false && isP(before, ":") && isP(toks[base], "="))
  ) {
    return "takes os.environ as a value the hook cannot follow";
  }
  if (isP(before, "[") || isP(before, "{") || isP(before, ":")) {
    return "puts os.environ in a container the hook cannot follow";
  }
  if (isP(before, "(") || isP(before, ",")) {
    // An argument: only a few functions that copy or print it.
    let open = base - 1;
    while (open >= 0 && !isP(toks[open], "(")) open -= 1;
    const callee = toks[open - 1];
    if (!(callee?.t === "id" && PY_ENVIRON_TAKERS.has(callee.v) && !isDot(toks[open - 2]))) {
      return "hands os.environ to code the hook cannot follow";
    }
  }
  return null;
}

// Builtin open() or a .open() method: read modes pass; a write needs a literal path.
function pyOpen(toks, i, match, prog, roots, caps, writes, what, receiverPath = undefined) {
  const open = i + 1;
  if (!isP(toks[open], "(")) {
    cap(caps, `uses ${what} in a way the hook cannot follow`);
    return;
  }
  const args = callArgs(toks, open, match);
  const isMethod = receiverPath !== undefined;
  let pathArg = null;
  let modeArg = null;
  let positional = 0;
  for (const [a, z] of args) {
    if (isP(toks[a], "*") || isP(toks[a], "**")) {
      cap(caps, `calls ${what} with arguments the hook cannot read`);
      return;
    }
    const kw = kwName(toks, a, z);
    if (kw === "opener") {
      cap(caps, `calls ${what} with a custom opener`);
      return;
    }
    if (kw === "file") pathArg = [a + 2, z];
    else if (kw === "mode") modeArg = [a + 2, z];
    else if (!kw) {
      if (!isMethod && positional === 0) pathArg = [a, z];
      else if ((isMethod && positional === 0) || (!isMethod && positional === 1)) modeArg = [a, z];
      positional += 1;
    }
  }
  if (!modeArg) return; // read
  const mode = literalAt(toks, modeArg[0], modeArg[1]);
  if (mode !== null && /^[rbtU]*$/.test(mode)) return; // a plain read mode
  if (mode === null) {
    cap(caps, `calls ${what} with a mode that is not a plain literal`);
    return;
  }
  const path = isMethod ? receiverPath : pathArg && literalAt(toks, pathArg[0], pathArg[1]);
  if (path === null || path === undefined) {
    cap(caps, `writes through ${what} to a path that is not a plain literal`);
    return;
  }
  writes.push({ paths: [path], what });
}

// The literal path of a `Path("x")` / `pathlib.Path("x")` receiver ending just before i
// (i is the `.`), or null.
function pyPathReceiver(toks, dot, match) {
  const close = dot - 1;
  if (!isP(toks[close], ")")) return null;
  const open = match[close];
  if (open < 1) return null;
  const ctor = toks[open - 1];
  if (ctor?.t !== "id" || !/^(?:Path|PosixPath|PurePath|PurePosixPath)$/.test(ctor.v)) return null;
  return literalAt(toks, open + 1, close);
}

function pyAttribute(toks, i, match, bindings, prog, roots, caps, writes) {
  const name = toks[i].v;
  const next = toks[i + 1];
  if (PY_CHAIN_CAP.has(name)) {
    cap(caps, `reaches the module .${name}`);
    return;
  }
  if (name === "io" || name === "codecs" || name === "urllib") {
    // `tokenize.io.FileIO(...)`: a restricted module reached through another keeps its list.
    const member = isDot(next) && toks[i + 2]?.t === "id" ? toks[i + 2].v : null;
    if (member === null || !PY_RESTRICTED[name].has(member)) {
      cap(caps, `reaches .${name}${member ? "." + member : ""}`);
      return;
    }
  }
  if (name === "open") {
    const recv = pyPathReceiver(toks, i - 1, match);
    pyOpen(toks, i, match, prog, roots, caps, writes, ".open()", recv);
    return;
  }
  if (PY_PATH_WRITES[name] !== undefined) {
    if (!isP(next, "(")) {
      if (name === "copy" || name === "replace" || name === "move") return;
      cap(caps, `uses .${name} in a way the hook cannot follow`);
      return;
    }
    const args = callArgs(toks, i + 1, match);
    // str.replace(a, b), dict.copy(), copy.copy(x) are not path methods.
    if (name === "replace" && args.length !== 1) return;
    if (name === "copy" && (args.length === 0 || toks[i - 2]?.v === "copy")) return;
    if (name === "move" && args.length === 0) return;
    const recv = pyPathReceiver(toks, i - 1, match);
    const others = args.slice(0, PY_PATH_WRITES[name]).map(([a, z]) => literalAt(toks, a, z));
    // A copy reads its receiver and writes only the target.
    const copy = name === "copy" || name === "copy_into";
    if ((recv === null && !copy) || others.some((p) => p === null)) {
      cap(caps, `writes through .${name}() to a path that is not a plain literal`);
      return;
    }
    writes.push({ paths: copy ? others : [recv, ...others], what: `.${name}()` });
    return;
  }
  if (PY_DANGER_ATTRS.has(name)) {
    cap(caps, `reaches .${name}`);
    return;
  }
  if (PY_SAVE_METHODS.has(name) && isP(next, "(")) {
    // A package's save method (numpy.save, DataFrame.to_csv, savefig): a literal path only.
    const args = callArgs(toks, i + 1, match);
    let pathArg = args[0];
    for (const [a, z] of args) {
      const kw = kwName(toks, a, z);
      if (kw && /^(?:path|fname|file|filename|path_or_buf|excel_writer)$/.test(kw))
        pathArg = [a + 2, z];
    }
    const path = pathArg ? literalAt(toks, pathArg[0], pathArg[1]) : null;
    if (path === null) cap(caps, `saves through .${name}() to a path that is not a plain literal`);
    else writes.push({ paths: [path], what: `.${name}()` });
  }
}

// ---------------------------------------------------------------------
// JAVASCRIPT (node, deno, bun)
// ---------------------------------------------------------------------
const JS_SAFE_MODULES = new Set(
  (
    "assert assert/strict async_hooks buffer console constants crypto diagnostics_channel domain " +
    "events os path path/posix path/win32 perf_hooks punycode querystring readline " +
    "readline/promises stream stream/promises stream/web string_decoder sys timers " +
    "timers/promises tty url util util/types zlib"
  ).split(" "),
);
const JS_BUILTINS = new Set(
  (
    "assert async_hooks buffer child_process cluster console constants crypto dgram " +
    "diagnostics_channel dns domain events fs http http2 https inspector module net os path " +
    "perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls " +
    "trace_events tty url util v8 vm wasi worker_threads zlib"
  ).split(" "),
);
const FS_READ = new Set(
  (
    "readFileSync readFile existsSync exists statSync stat lstatSync lstat readdirSync readdir " +
    "realpathSync realpath readlinkSync readlink accessSync access createReadStream constants " +
    "fstatSync fstat readSync read closeSync close opendirSync opendir watch watchFile " +
    "unwatchFile Stats Dirent ReadStream F_OK R_OK W_OK X_OK"
  ).split(" "),
);
// fs writes that pass when every path is a literal in a write root: name -> path args.
const FS_WRITES = {
  writeFileSync: 1,
  writeFile: 1,
  appendFileSync: 1,
  appendFile: 1,
  createWriteStream: 1,
  mkdirSync: 1,
  mkdir: 1,
  rmSync: 1,
  rm: 1,
  rmdirSync: 1,
  rmdir: 1,
  unlinkSync: 1,
  unlink: 1,
  truncateSync: 1,
  truncate: 1,
  chmodSync: 1,
  chmod: 1,
  utimesSync: 1,
  utimes: 1,
  copyFileSync: 2,
  copyFile: 2,
  cpSync: 2,
  cp: 2,
  renameSync: 2,
  rename: 2,
  symlinkSync: 2,
  symlink: 2,
  linkSync: 2,
  link: 2,
};
const PROCESS_ALLOWED = new Set(
  (
    "env argv argv0 execArgv cwd exit exitCode stdout stderr stdin platform version versions " +
    "arch pid ppid hrtime uptime memoryUsage nextTick on once off emitWarning release config " +
    "execPath title features resourceUsage cpuUsage getuid getgid geteuid getegid getgroups " +
    "emit listeners removeAllListeners allowedNodeEnvironmentFlags constrainedMemory " +
    "availableMemory sourceMapsEnabled"
  ).split(" "),
);
const DENO_ALLOWED = new Set(
  (
    "version args env cwd readTextFile readTextFileSync readFile readFileSync readDir " +
    "readDirSync stat statSync lstat lstatSync realPath realPathSync readLink readLinkSync build " +
    "pid ppid noColor exit inspect memoryUsage osRelease hostname stdin stdout stderr " +
    "consoleSize errors execPath exitCode mainModule"
  ).split(" "),
);
const DENO_WRITES = { writeTextFile: 1, writeTextFileSync: 1, writeFile: 1, writeFileSync: 1 };
const BUN_ALLOWED = new Set(
  "version revision env argv main nanoseconds sleep sleepSync inspect deepEquals escapeHTML hash CryptoHasher stdout stderr stdin".split(
    " ",
  ),
);
const JS_DANGER_IDS = new Set(
  "eval Function globalThis global window self module Reflect fetch WebSocket XMLHttpRequest EventSource Worker SharedWorker importScripts".split(
    " ",
  ),
);
const JS_DANGER_ATTRS = new Set(
  (
    "constructor __proto__ __defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__ " +
    "caller callee binding _linkedBinding dlopen mainModule getBuiltinModule prepareStackTrace " +
    "execSync execFileSync spawnSync execFile spawn fork kill chdir report require process " +
    "promises writeFileSync appendFileSync createWriteStream writeSync copyFileSync cpSync " +
    "renameSync rmSync rmdirSync unlinkSync mkdirSync symlinkSync linkSync truncateSync " +
    "chmodSync chownSync utimesSync mkdtempSync lchmodSync lchownSync lutimesSync futimesSync " +
    "fchmodSync fchownSync ftruncateSync writevSync writev writeFile appendFile copyFile " +
    "symlink mkdtemp writer openSync _load _compile _resolveFilename _extensions _cache " +
    "_initPaths _findPath _nodeModulePaths " +
    // Walking an object's hidden members reaches `constructor` without naming it.
    "getPrototypeOf setPrototypeOf getOwnPropertyNames getOwnPropertyDescriptor " +
    "getOwnPropertyDescriptors ownKeys"
  ).split(" "),
);
// Names that are a capability wherever they appear as a bare identifier, not only after a
// dot: a destructuring key (`const { execSync: x } = m`) reaches the member as surely.
const JS_STRICT_IDS = new Set(
  (
    "execSync execFileSync spawnSync execFile _linkedBinding dlopen mainModule " +
    "getBuiltinModule prepareStackTrace writeFileSync appendFileSync createWriteStream " +
    "writeSync copyFileSync cpSync renameSync rmSync rmdirSync unlinkSync mkdirSync " +
    "symlinkSync linkSync truncateSync chmodSync chownSync utimesSync mkdtempSync lchmodSync " +
    "lchownSync lutimesSync futimesSync fchmodSync fchownSync ftruncateSync writevSync _load " +
    "_compile _resolveFilename _extensions _cache _initPaths _findPath _nodeModulePaths " +
    "__defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__ getPrototypeOf " +
    "setPrototypeOf getOwnPropertyNames getOwnPropertyDescriptor getOwnPropertyDescriptors"
  ).split(" "),
);
// String values that name an escape: `x["constructor"]`, `require("child_process")`.
const JS_DANGER_NAMES = new Set(
  "constructor __proto__ require process mainModule binding dlopen eval Function child_process getBuiltinModule globalThis execSync spawnSync execFileSync".split(
    " ",
  ),
);
// Modules that ARE a capability (builtins and well-known packages).
const JS_CAP_MODULES = new Set(
  (
    "child_process worker_threads cluster net http https http2 dgram dns dns/promises tls vm v8 " +
    "inspector repl module wasi trace_events fs/promises sqlite sea test process shelljs execa " +
    "cross-spawn node-fetch axios got undici fs-extra rimraf mkdirp graceful-fs tmp puppeteer " +
    "playwright ssh2 ws request superagent zx node-pty @actions/exec @actions/io nodemailer " +
    "open opener sudo-prompt write-file-atomic jsonfile del cpy make-dir move-file tar " +
    "adm-zip archiver unzipper extract-zip basic-ftp ssh2-sftp-client simple-git " +
    // Build tools and template engines that write files or compile strings into code.
    "esbuild vite rollup webpack tinyexec nano-spawn @npmcli/run-script @npmcli/promise-spawn " +
    "spawndamnit ejs pug handlebars nunjucks lodash.template vm2 isolated-vm bun npm pnpm " +
    "yarn corepack npx"
  ).split(" "),
);
// Packages whose version fields are read in one-liners but whose API can write or compile
// code (`typescript.sys.writeFile`, `lodash.template`): only the version members pass.
const JS_VERSION_ONLY = new Set(["typescript", "lodash", "underscore", "lodash-es"]);

function jsModulePolicy(spec) {
  const m = spec.replace(/^node:/, "");
  // `data:` and `https:` URLs carry or fetch a program; `/dev/stdin` and `/proc/self/fd/0`
  // read one from input; `bun:ffi` and the rest of bun's own modules are capabilities.
  if (/^[A-Za-z][\w+.-]*:/.test(m)) return { cap: true, mod: m };
  if (/^\/(?:dev|proc)\//.test(m)) return { cap: true, mod: m };
  if (JS_VERSION_ONLY.has(m)) return { unknown: true, mod: m };
  if (/^(?:\.{1,2}\/|\/)/.test(m) || m === "." || m === "..") {
    if (/\.json$/.test(m)) return { safe: true };
    // A path into node_modules names a package: judge it by its name.
    const pkg = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(m);
    if (pkg) return jsModulePolicy(pkg[1]);
    // An absolute path is installed code the hook cannot name (`/usr/share/nodejs/npm/...`);
    // a relative one is a file in the worktree (the documented residual).
    if (m.startsWith("/")) return { cap: true, mod: m };
    return { safe: true };
  }
  if (m === "fs") return { fs: true, mod: "fs" };
  if (JS_CAP_MODULES.has(m) || m.startsWith("_") || m.startsWith("fs/"))
    return { cap: true, mod: m };
  if (JS_SAFE_MODULES.has(m) || JS_BUILTINS.has(m.split("/")[0]) === false) return { safe: true };
  return { cap: true, mod: m };
}

// Fold `"a" + "b" + ...` starting at i into one string, or null.
function foldConcat(toks, i) {
  let v = literalAt(toks, i, i + 1);
  if (v === null) return null;
  let k = i + 1;
  let folded = false;
  while (isP(toks[k], "+") && literalAt(toks, k + 1, k + 2) !== null) {
    v += toks[k + 1].v;
    k += 2;
    folded = true;
  }
  return folded ? v : null;
}

function analyseJs(toks, prog, roots, caps, writes) {
  const match = matchBrackets(toks);
  const bindings = new Map(); // name -> { kind: fs|process|unknown|cap|safe|fsfn, mod, member }
  const done = new Uint8Array(toks.length);
  const policyBinding = (policy) =>
    policy.fs
      ? { kind: "fs" }
      : policy.cap
        ? { kind: "cap", mod: policy.mod }
        : policy.unknown
          ? { kind: "unknown", mod: policy.mod }
          : { kind: "safe" };
  // Module-member check (`require("fs").X`, `fs.X`, `{X} = require("fs")`): null or why.
  const memberWhy = (kind, mod, member) => {
    if (kind === "safe") return null;
    if (kind === "cap") return `uses ${mod}`;
    if (kind === "unknown") {
      return VERSION_ATTRS.has(member)
        ? null
        : `uses ${mod}.${member}, from a module the hook does not know`;
    }
    if (kind === "process") return PROCESS_ALLOWED.has(member) ? null : `uses process.${member}`;
    if (kind === "fs") {
      if (FS_READ.has(member) || FS_WRITES[member] !== undefined) return null;
      if (
        member === "openSync" ||
        member === "open" ||
        member === "writeSync" ||
        member === "write"
      )
        return null;
      return `uses fs.${member}`;
    }
    return null;
  };
  // A call of an fs function `member` whose `(` is at `open`.
  const fsCall = (member, open, label) => {
    if (FS_READ.has(member)) return;
    if (!isP(toks[open], "(")) {
      cap(caps, `uses ${label} in a way the hook cannot follow`);
      return;
    }
    const args = callArgs(toks, open, match);
    if (member === "writeSync" || member === "write") {
      const fd = args[0] && toks[args[0][0]];
      if (
        args[0] &&
        args[0][1] - args[0][0] === 1 &&
        fd.t === "num" &&
        (fd.v === "1" || fd.v === "2")
      )
        return;
      cap(caps, `writes through ${label} to a file descriptor the hook cannot follow`);
      return;
    }
    if (member === "openSync" || member === "open") {
      const flag = args[1];
      if (!flag) return;
      const lit = literalAt(toks, flag[0], flag[1]);
      const num = flag[1] - flag[0] === 1 && toks[flag[0]].t === "num" ? toks[flag[0]].v : null;
      if ((lit !== null && /^(?:r|rs|sr)$/.test(lit)) || num === "0") return;
      const path = literalAt(toks, args[0][0], args[0][1]);
      if (path === null)
        cap(caps, `opens through ${label} for writing a path that is not a plain literal`);
      else writes.push({ paths: [path], what: label });
      return;
    }
    const n = FS_WRITES[member];
    // A copy reads its source (judged as a read) and writes only its destination.
    const pathArgs = /^(?:copyFile|copyFileSync|cp|cpSync)$/.test(member)
      ? args.slice(1, 2)
      : args.slice(0, n);
    const paths = pathArgs.map(([a, z]) => literalAt(toks, a, z));
    if (paths.length < pathArgs.length || pathArgs.length === 0 || paths.some((p) => p === null)) {
      cap(caps, `writes through ${label} to a path that is not a plain literal`);
    } else writes.push({ paths, what: label });
  };

  // Names assigned a member picked at run time (`const F = o[k]`): calling one is refused.
  const tainted = new Set();
  // Names the program declares shadow the builtins node -e puts on the global object.
  const declared = new Set();
  for (let i = 0; i + 1 < toks.length; i += 1) {
    const t = toks[i];
    if (t.t !== "id" || !/^(?:const|let|var|function|class)$/.test(t.v)) continue;
    const n = toks[i + 1];
    if (n.t === "id") declared.add(n.v);
    else if ((isP(n, "{") || isP(n, "[")) && match[i + 1] > i + 1) {
      for (let k = i + 2; k < match[i + 1]; k += 1) if (toks[k].t === "id") declared.add(toks[k].v);
    }
  }
  // Class bodies are strict code where `this` is the instance, never the global object.
  const inClass = new Uint8Array(toks.length);
  for (let i = 0; i < toks.length; i += 1) {
    if (toks[i].t !== "id" || toks[i].v !== "class") continue;
    let k = i + 1;
    while (k < toks.length && k - i < 8 && !isP(toks[k], "{")) k += 1;
    if (isP(toks[k], "{") && match[k] > k) inClass.fill(1, k, match[k]);
  }
  // `const { env, argv } = process`: each name is checked like `process.name`.
  for (let i = 2; i < toks.length; i += 1) {
    if (
      toks[i].t === "id" &&
      toks[i].v === "process" &&
      isP(toks[i - 1], "=") &&
      isP(toks[i - 2], "}") &&
      match[i - 2] >= 0
    ) {
      jsDestructure(
        toks,
        match[i - 2],
        i - 2,
        { kind: "process" },
        bindings,
        done,
        caps,
        (kind, mod, m) => (PROCESS_ALLOWED.has(m) ? null : `uses process.${m}`),
      );
      done[i] = 1;
    }
  }
  // Bindings: `X = require("m")[.member]`, `{a, b: c} = require("m")`, `import ... from "m"`.
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.t !== "id") continue;
    if (t.v === "require" && !isDot(toks[i - 1])) {
      if (!isP(toks[i + 1], "(")) {
        if (isDot(toks[i + 1]) && toks[i + 2]?.v === "resolve") continue;
        cap(caps, "uses require in a way the hook cannot follow");
        continue;
      }
      const close = match[i + 1];
      const spec = literalAt(toks, i + 2, close);
      if (spec === null) {
        cap(caps, "requires a module whose name is built at run time");
        continue;
      }
      const policy = jsModulePolicy(spec);
      if (policy.cap) {
        cap(caps, `requires ${spec}`);
        continue;
      }
      if (policy.safe) continue;
      const b = policyBinding(policy);
      // What the module is used as: a member, a binding, a destructuring, or anything else.
      let member = null;
      if (isDot(toks[close + 1]) && toks[close + 2]?.t === "id") member = toks[close + 2].v;
      if (isP(toks[close + 1], "[")) {
        cap(caps, `picks a member of ${spec} at run time`);
        continue;
      }
      if (member) {
        const why = memberWhy(b.kind, b.mod, member);
        if (why) {
          cap(caps, why);
          continue;
        }
        if (b.kind === "fs") {
          done[close + 2] = 1;
          if (isP(toks[close + 3], "(")) {
            fsCall(member, close + 3, `fs.${member}`);
            continue;
          }
        }
      }
      const eq = toks[i - 1];
      if (isP(eq, "=") && toks[i - 2]?.t === "id") {
        bindings.set(
          toks[i - 2].v,
          member ? { kind: b.kind === "fs" ? "fsfn" : "safe", member } : b,
        );
        done[i - 2] = 1;
      } else if (isP(eq, "=") && isP(toks[i - 2], "}") && !member) {
        jsDestructure(toks, match[i - 2], i - 2, b, bindings, done, caps, memberWhy);
      } else if (!member || isP(toks[close + 3], "(") === false) {
        if (!member) cap(caps, `uses the module ${spec} in a way the hook cannot follow`);
      }
      continue;
    }
    if (t.v === "import" && !isDot(toks[i - 1])) {
      if (isDot(toks[i + 1]) && toks[i + 2]?.v === "meta") continue;
      if (isP(toks[i + 1], "(")) {
        const spec = literalAt(toks, i + 2, match[i + 1]);
        if (spec === null) cap(caps, "imports a module whose name is built at run time");
        else {
          const policy = jsModulePolicy(spec);
          if (!policy.safe) cap(caps, `imports ${spec} where the hook cannot follow its use`);
        }
        continue;
      }
      // Static import: find `from "m"` (or `import "m"`).
      let k = i + 1;
      while (
        k < toks.length &&
        !(toks[k].t === "id" && toks[k].v === "from") &&
        toks[k].t !== "str"
      ) {
        k += 1;
        if (k - i > 256) break;
      }
      const specTok = toks[k]?.t === "str" ? toks[k] : toks[k + 1];
      const spec = specTok && specTok.t === "str" && specTok.exact ? specTok.v : null;
      if (spec === null) {
        cap(caps, "imports a module the hook cannot name");
        continue;
      }
      const policy = jsModulePolicy(spec);
      if (policy.cap) {
        cap(caps, `imports ${spec}`);
        continue;
      }
      const b = policyBinding(policy);
      for (let m = i + 1; m < k; m += 1) {
        const x = toks[m];
        if (x.t !== "id" || x.v === "as" || x.v === "from") continue;
        done[m] = 1;
        if (isP(toks[m - 1], "*") || (toks[m - 1]?.v === "as" && isP(toks[m - 2], "*"))) {
          bindings.set(x.v, b);
        } else if (toks[m - 1]?.v === "as") {
          // `{ a as b }`: b is bound to member a.
          const member = toks[m - 2].v;
          const why = memberWhy(b.kind, b.mod, member);
          if (why) cap(caps, why);
          bindings.set(x.v, { kind: b.kind === "fs" ? "fsfn" : "safe", member });
        } else if (toks[m + 1]?.v === "as") {
          continue;
        } else if (match[i + 1] > m || toks.slice(i + 1, m).some((y) => isP(y, "{"))) {
          const inBraces =
            toks.slice(i + 1, m).some((y) => isP(y, "{")) &&
            !toks.slice(i + 1, m).some((y) => isP(y, "}"));
          if (inBraces) {
            const why = memberWhy(b.kind, b.mod, x.v);
            if (why) cap(caps, why);
            bindings.set(x.v, { kind: b.kind === "fs" ? "fsfn" : "safe", member: x.v });
          } else bindings.set(x.v, b);
        } else bindings.set(x.v, b);
      }
      for (let m = i; m <= k + 1 && m < toks.length; m += 1) done[m] = 1;
    }
  }

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (t.t === "str") {
      const folded = isP(prev, "+") ? null : foldConcat(toks, i);
      if (
        t.exact &&
        JS_DANGER_NAMES.has(t.v) &&
        !(isP(prev, "(") && toks[i - 2]?.v === "require")
      ) {
        cap(caps, `names ${t.v} in a string`);
      } else if (folded !== null && JS_DANGER_NAMES.has(folded)) {
        cap(caps, `builds the name ${folded} from strings`);
      }
      continue;
    }
    if (
      isP(t, "[") &&
      i > 0 &&
      ((prev.t === "id" && !JS_KEYWORDS_BEFORE_VALUE.has(prev.v)) ||
        isP(prev, "?.") ||
        prev.t === "str" ||
        isP(prev, ")") ||
        isP(prev, "]"))
    ) {
      jsComputed(toks, i, match, bindings, caps, declared, tainted);
      continue;
    }
    if (
      isP(t, "[") &&
      (isP(prev, "{") || isP(prev, ",")) &&
      match[i] > i &&
      isP(toks[match[i] + 1], ":")
    ) {
      // `{ [k]: F } = o`: a computed key in an object literal or pattern.
      if (
        match[i] - i !== 2 ||
        (toks[i + 1].t !== "num" && literalAt(toks, i + 1, i + 2) === null)
      ) {
        cap(caps, "takes a member whose name is built at run time");
      }
      continue;
    }
    if (isP(t, "(") && isP(prev, ")") && match[i - 1] >= 0) {
      // `(0, o[k])(...)`: calling a parenthesised expression that picks a member at run time.
      const open = match[i - 1];
      if (i - open > 256 || jsHasRuntimeMember(toks, open, i - 1, match)) {
        cap(caps, "calls an expression that picks a member at run time");
      }
    }
    if (t.t !== "id" || done[i]) continue;
    const name = t.v;
    if (isDot(prev)) {
      if (JS_DANGER_ATTRS.has(name)) cap(caps, `reaches .${name}`);
      continue;
    }
    if (name === "this" && !inClass[i]) {
      // In sloppy code `this` is the global object at the top level and in a plain
      // function call (`(function(){return this})()`), with require and process on it.
      cap(caps, "uses this (the global object outside a class)");
      continue;
    }
    if (JS_STRICT_IDS.has(name) && !bindings.has(name)) {
      cap(caps, `names ${name}`);
      continue;
    }
    if (tainted.has(name) && (jsCalledAt(toks, i) || isP(prev, "(") || isP(prev, ","))) {
      cap(caps, `calls ${name}, a member picked at run time`);
      continue;
    }
    if (name === "constructor" || name === "__proto__") {
      // A destructured or keyed `constructor` (`const {constructor: F} = f`) reaches the
      // Function constructor as surely as `.constructor`; a class's own constructor is fine.
      if (!(name === "constructor" && inClass[i] && isP(next, "("))) {
        cap(caps, `reaches ${name}`);
        continue;
      }
    }
    if (JS_DANGER_IDS.has(name)) {
      if (isP(next, ":") && (isP(prev, "{") || isP(prev, ","))) continue; // an object key
      cap(caps, `uses ${name}`);
      continue;
    }
    if (name === "Deno" || name === "Bun") {
      jsRuntimeGlobal(toks, i, match, caps, writes, name, done);
      continue;
    }
    // Bound names and the builtin modules node -e puts on the global object.
    let b = bindings.get(name);
    if (!b && JS_BUILTINS.has(name) && !declared.has(name)) {
      if (isP(next, ":") && (isP(prev, "{") || isP(prev, ","))) continue;
      if (isP(next, "=") && toks[i + 2]?.v !== "=") continue; // assigned, not used
      if (prev?.t === "id" && /^(?:const|let|var|function|class)$/.test(prev.v)) continue;
      b =
        name === "fs"
          ? { kind: "fs" }
          : name === "process"
            ? { kind: "process" }
            : policyBinding(jsModulePolicy(name));
    }
    if (!b || b.kind === "safe") continue;
    if (b.kind === "cap") {
      cap(caps, `uses ${b.mod ?? name}`);
      continue;
    }
    if (b.kind === "fsfn") {
      if (FS_READ.has(b.member)) continue;
      fsCall(b.member, i + 1, `fs.${b.member}`);
      continue;
    }
    if (!isDot(next) || toks[i + 2]?.t !== "id") {
      if (isP(next, "[")) continue; // judged as a computed member below
      cap(caps, `uses ${name} in a way the hook cannot follow`);
      continue;
    }
    const member = toks[i + 2].v;
    const why = memberWhy(b.kind, b.mod ?? name, member);
    if (why) {
      cap(caps, why);
      continue;
    }
    done[i + 2] = 1;
    if (b.kind === "fs") fsCall(member, i + 3, `fs.${member}`);
  }
}

function jsDestructure(toks, open, close, b, bindings, done, caps, memberWhy) {
  for (let k = open + 1; k < close; k += 1) {
    const x = toks[k];
    if (isP(x, "...")) {
      cap(caps, "takes the rest of a module's members");
      return;
    }
    if (x.t !== "id") continue;
    done[k] = 1;
    if (isP(toks[k + 1], ":")) {
      const why = memberWhy(b.kind, b.mod, x.v);
      if (why) cap(caps, why);
      const alias = toks[k + 2];
      if (alias?.t === "id") {
        bindings.set(alias.v, { kind: b.kind === "fs" ? "fsfn" : "safe", member: x.v });
        done[k + 2] = 1;
      }
      k += 2;
      continue;
    }
    const why = memberWhy(b.kind, b.mod, x.v);
    if (why) cap(caps, why);
    bindings.set(x.v, { kind: b.kind === "fs" ? "fsfn" : "safe", member: x.v });
  }
}

// `X[...]`: a member picked at run time.
// Keywords after which `[` opens an array literal or a pattern, not a member access.
const JS_KEYWORDS_BEFORE_VALUE = new Set(
  "const let var return typeof in of case new delete void throw yield await else do instanceof".split(
    " ",
  ),
);

// Whether the identifier at i is called: `f(`, `` f`...` ``, `f.call(`, `new f`.
function jsCalledAt(toks, i) {
  const next = toks[i + 1];
  if (isP(next, "(") || (next?.t === "str" && next.kind === "template")) return true;
  if (isDot(next) && /^(?:call|apply|bind)$/.test(toks[i + 2]?.v ?? "")) return true;
  return toks[i - 1]?.t === "id" && toks[i - 1].v === "new";
}

// Whether toks (a, b) hold a computed member access with a key that is not a literal.
function jsHasRuntimeMember(toks, a, b, match) {
  for (let k = a + 1; k < b; k += 1) {
    if (!isP(toks[k], "[")) continue;
    const p = toks[k - 1];
    if (!(p.t === "id" || p.t === "str" || isP(p, ")") || isP(p, "]"))) continue;
    const c = match[k];
    if (c !== k + 2) return true;
    if (toks[k + 1].t !== "num" && literalAt(toks, k + 1, k + 2) === null) return true;
  }
  return false;
}

function jsComputed(toks, open, match, bindings, caps, declared, tainted = new Set()) {
  const close = match[open];
  if (close < 0) return;
  const prev = toks[open - 1];
  const bound = prev.t === "id" ? bindings.get(prev.v) : undefined;
  const builtin = prev.t === "id" && !bound && !declared.has(prev.v) && JS_BUILTINS.has(prev.v);
  if ((bound && bound.kind !== "safe") || (builtin && !JS_SAFE_MODULES.has(prev.v))) {
    cap(caps, `picks a member of ${prev.v} at run time`);
    return;
  }
  const inner = close - open - 1 <= 16 ? toks.slice(open + 1, close) : null;
  let kind = "complex";
  if (inner === null) {
    cap(caps, "picks a member with a name built at run time");
    return;
  }
  if (inner.length === 1 && inner[0].t === "num") kind = "num";
  else if (inner.length === 1 && inner[0].t === "str" && inner[0].exact && !inner[0].interp) {
    kind = JS_DANGER_NAMES.has(inner[0].v) ? "danger" : "str";
  } else if (inner.length === 1 && inner[0].t === "id") kind = "ident";
  else if (
    inner.every((x) => x.t === "num" || x.t === "id" || (x.t === "p" && /^[-+*/%.]$/.test(x.v)))
  ) {
    kind = "arith";
  }
  const after = toks[close + 1];
  if (kind === "num" && (isP(after, "(") || (after?.t === "str" && after.kind === "template"))) {
    cap(caps, "calls a member picked by index");
    return;
  }
  if (kind === "ident" || kind === "arith") {
    if (
      (after?.t === "str" && after.kind === "template") ||
      (isDot(after) && /^(?:call|apply|bind)$/.test(toks[close + 2]?.v ?? ""))
    ) {
      cap(caps, "calls a member picked at run time");
      return;
    }
    // `F = a.b[k]`: remember F, refused if it is called.
    let k = open - 1;
    let steps = 0;
    while (k >= 0) {
      if (++steps > 256) {
        // Bounded work: a member chain this long is refused rather than walked.
        cap(caps, "picks members in a chain longer than the hook reads");
        return;
      }
      if (toks[k].t === "id" || isDot(toks[k])) k -= 1;
      else if ((isP(toks[k], ")") || isP(toks[k], "]")) && match[k] >= 0 && match[k] < k)
        k = match[k] - 1;
      else break;
    }
    if (isP(toks[k], "=") && toks[k - 1]?.t === "id") tainted.add(toks[k - 1].v);
  }
  if (kind === "danger") cap(caps, `reaches the member "${inner[0].v}"`);
  else if (kind === "complex") cap(caps, "picks a member with a name built at run time");
  else if ((kind === "ident" || kind === "arith") && isP(after, "(")) {
    cap(caps, "calls a member picked at run time");
  } else if ((kind === "ident" || kind === "arith") && isP(after, "[")) {
    const c2 = match[close + 1];
    if (!(c2 === close + 3 && toks[close + 2].t === "num"))
      cap(caps, "walks members picked at run time");
  }
}

function jsRuntimeGlobal(toks, i, match, caps, writes, name, done) {
  if (!isDot(toks[i + 1]) || toks[i + 2]?.t !== "id") {
    cap(caps, `uses ${name} in a way the hook cannot follow`);
    return;
  }
  const member = toks[i + 2].v;
  done[i + 2] = 1;
  const open = i + 3;
  if (name === "Deno" && DENO_WRITES[member] !== undefined) {
    const args = isP(toks[open], "(") ? callArgs(toks, open, match) : [];
    const path = args[0] ? literalAt(toks, args[0][0], args[0][1]) : null;
    if (path === null)
      cap(caps, `writes through Deno.${member} to a path that is not a plain literal`);
    else writes.push({ paths: [path], what: `Deno.${member}` });
    return;
  }
  if (name === "Bun" && member === "write") {
    const args = isP(toks[open], "(") ? callArgs(toks, open, match) : [];
    const path = args[0] ? literalAt(toks, args[0][0], args[0][1]) : null;
    if (path === null)
      cap(caps, "writes through Bun.write to a destination that is not a plain literal");
    else writes.push({ paths: [path], what: "Bun.write" });
    return;
  }
  if (name === "Bun" && member === "file") {
    // `Bun.file(p).text()` reads; anything else (`.writer()`, `.write()`, `.delete()`, or
    // the file kept in a variable for later) is refused.
    const close = isP(toks[open], "(") ? match[open] : -1;
    const after = close > 0 ? toks[close + 2] : null;
    if (!(
      close > 0 &&
      isDot(toks[close + 1]) &&
      after &&
      /^(?:text|json|arrayBuffer|bytes|stream|exists|size|type|name|lastModified)$/.test(after.v)
    )) {
      cap(caps, `uses Bun.file()${after?.v ? "." + after.v : ""} in a way that may write`);
    }
    return;
  }
  const allowed = name === "Deno" ? DENO_ALLOWED : BUN_ALLOWED;
  if (!allowed.has(member)) cap(caps, `uses ${name}.${member}`);
}

// ---------------------------------------------------------------------
// RUBY
// ---------------------------------------------------------------------
const RUBY_SAFE_LIBS = new Set(
  "json yaml psych time date set pp securerandom digest digest/md5 digest/sha1 digest/sha2 base64 ostruct bigdecimal English shellwords strscan optparse prime matrix abbrev rbconfig stringio benchmark".split(
    " ",
  ),
);
const RUBY_DANGER = new Set(
  (
    "system exec spawn fork syscall eval instance_eval class_eval module_eval instance_exec " +
    "class_exec module_exec binding send __send__ public_send method public_method " +
    "instance_method define_method const_get const_set unsafe_load reopen popen popen2 popen3 " +
    "popen2e capture2 capture2e capture3 pipeline pipeline_r pipeline_w autoload load " +
    "ObjectSpace Kernel Process IO Open3 PTY Socket TCPSocket TCPServer UDPSocket UNIXSocket " +
    "UNIXServer BasicSocket Addrinfo Net OpenURI FileUtils Pathname Tempfile Fiddle DL Marshal " +
    "Gem Bundler RubyVM TracePoint Binding DRb Ractor trap"
  ).split(" "),
);
const RUBY_FILE_READ = new Set(
  (
    "read readlines foreach exist? exists? file? directory? readable? size size? zero? empty? " +
    "mtime atime ctime birthtime stat lstat basename dirname extname join expand_path " +
    "absolute_path absolute_path? realpath realdirpath split fnmatch fnmatch? ftype symlink? " +
    "executable? writable? binread readlink identical? path SEPARATOR ALT_SEPARATOR " +
    "PATH_SEPARATOR Constants"
  ).split(" "),
);
const RUBY_FILE_WRITES = {
  write: 1,
  binwrite: 1,
  delete: 1,
  unlink: 1,
  truncate: 1,
  chmod: 0,
  rename: 2,
  symlink: 2,
  link: 2,
  mkfifo: 1,
};
const RUBY_DIR_READ = new Set(
  "glob [] entries children each_child exist? exists? pwd getwd home foreach empty?".split(" "),
);

function analyseRuby(toks, prog, roots, caps, writes) {
  const match = matchBrackets(toks);
  for (const lib of prog.preload ?? []) {
    if (!RUBY_SAFE_LIBS.has(lib)) cap(caps, `loads the library ${lib}`);
  }
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (t.t === "str" && t.command) {
      cap(caps, "runs a command (backticks or %x)");
      continue;
    }
    if (t.t !== "id") continue;
    const name = t.v;
    const attr = isDot(prev) || isP(prev, "::");
    if (!attr && (name === "require" || name === "require_relative")) {
      const a = isP(next, "(") ? i + 2 : i + 1;
      const lit = literalAt(toks, a, a + 1);
      if (lit === null) cap(caps, `${name}s a library whose name is built at run time`);
      else if (name === "require" && !RUBY_SAFE_LIBS.has(lit)) cap(caps, `requires ${lit}`);
      else if (lit.startsWith("/")) {
        cap(caps, `${name}s ${lit} (installed code or input, not a worktree file)`);
      }
      continue;
    }
    if (RUBY_DANGER.has(name)) {
      if (isP(prev, ":") && !isP(toks[i - 2], ":")) {
        cap(caps, `names :${name}`);
        continue;
      }
      cap(caps, `uses ${name}`);
      continue;
    }
    if (!attr && name === "open") {
      rubyOpen(toks, i, match, caps, writes, "open", null);
      continue;
    }
    if ((name === "File" || name === "Dir" || name === "URI") && !attr) {
      if (!(isDot(next) || isP(next, "::")) || toks[i + 2]?.t !== "id") {
        cap(caps, `uses ${name} in a way the hook cannot follow`);
        continue;
      }
      const member = toks[i + 2].v;
      i += 2;
      if (name === "URI") {
        if (member === "open") cap(caps, "opens a URI");
        continue;
      }
      if (name === "Dir") {
        if (!RUBY_DIR_READ.has(member)) cap(caps, `uses Dir.${member}`);
        continue;
      }
      if (RUBY_FILE_READ.has(member)) {
        // IO.read("|cmd") runs a command; File's readers inherit it on older rubies.
        const args = rubyArgs(toks, i + 1, match);
        const first = args[0] ? literalAt(toks, args[0][0], args[0][1]) : null;
        if (first !== null && first.trimStart().startsWith("|"))
          cap(caps, "reads from a pipe to a command");
        continue;
      }
      if (member === "open" || member === "new") {
        rubyOpen(toks, i, match, caps, writes, `File.${member}`, null);
        continue;
      }
      const n = RUBY_FILE_WRITES[member];
      if (n === undefined) {
        cap(caps, `uses File.${member}`);
        continue;
      }
      const args = rubyArgs(toks, i + 1, match);
      // chmod(mode, path...): the paths follow the mode.
      const pathArgs = member === "chmod" ? args.slice(1) : args.slice(0, n);
      const paths = pathArgs.map(([a, z]) => literalAt(toks, a, z));
      if (paths.length === 0 || paths.length < n || paths.some((p) => p === null)) {
        cap(caps, `writes through File.${member} to a path that is not a plain literal`);
      } else writes.push({ paths, what: `File.${member}` });
    }
  }
}

// Ruby call arguments with or without parentheses: from the token at `at`.
function rubyArgs(toks, at, match) {
  if (isP(toks[at], "(")) return callArgs(toks, at, match);
  const args = [];
  let a = at;
  const stop = Math.min(toks.length, at + MAX_BARE_ARGS);
  for (let i = at; i < stop; i += 1) {
    const t = toks[i];
    if (t.t === "p" && (t.v === "(" || t.v === "[" || t.v === "{") && match[i] > i) {
      if (t.v === "{" && i > a) break; // a block
      i = match[i];
      continue;
    }
    if (
      (t.t === "p" && (t.v === ";" || t.v === ")" || t.v === "}")) ||
      (t.nl && i > at) ||
      (t.t === "id" && t.v === "do")
    ) {
      if (i > a) args.push([a, i]);
      return args;
    }
    if (t.t === "p" && t.v === ",") {
      args.push([a, i]);
      a = i + 1;
    }
  }
  if (stop < toks.length) return [];
  if (toks.length > a) args.push([a, toks.length]);
  return args;
}

function rubyOpen(toks, i, match, caps, writes, what) {
  const args = rubyArgs(toks, i + 1, match);
  if (args.length === 0) {
    cap(caps, `uses ${what} in a way the hook cannot follow`);
    return;
  }
  const path = literalAt(toks, args[0][0], args[0][1]);
  if (path !== null && what === "open" && path.trimStart().startsWith("|")) {
    cap(caps, "opens a pipe to a command");
    return;
  }
  const modeArg = args[1];
  if (!modeArg) {
    if (path === null && what === "open")
      cap(caps, "opens a path that is not a plain literal (it could be a pipe)");
    return;
  }
  const mode = literalAt(toks, modeArg[0], modeArg[1]);
  if (mode !== null && /^r[bt]?(?::[\w-]+)*$/.test(mode)) {
    if (path === null && what === "open")
      cap(caps, "opens a path that is not a plain literal (it could be a pipe)");
    return;
  }
  if (path === null) {
    cap(caps, `writes through ${what} to a path that is not a plain literal`);
    return;
  }
  if (mode === null) {
    cap(caps, `calls ${what} with a mode that is not a plain literal`);
    return;
  }
  writes.push({ paths: [path], what });
}

// ---------------------------------------------------------------------
// PERL
// ---------------------------------------------------------------------
const PERL_SAFE_MODULES = new Set(
  (
    "strict warnings utf8 feature integer bytes constant vars lib English Carp Data::Dumper " +
    "JSON::PP JSON List::Util Scalar::Util Time::Local Time::HiRes Time::Piece Getopt::Long " +
    "Getopt::Std MIME::Base64 Digest::MD5 Digest::SHA Encode Cwd File::Basename File::Spec " +
    "File::Spec::Functions File::Find Text::Wrap Text::ParseWords Term::ANSIColor Math::BigInt " +
    "Math::BigFloat Math::Trig Unicode::Normalize open locale overload Hash::Util POSIX::strftime"
  ).split(" "),
);
const PERL_DANGER = new Set(
  (
    "system exec fork readpipe syscall kill pipe socket socketpair connect bind listen accept " +
    "shutdown send sysopen unlink rename link symlink mkdir rmdir chmod chown utime truncate " +
    "chdir chroot dbmopen dbmclose ioctl fcntl CORE UNIVERSAL can"
  ).split(" "),
);
const PERL_WRITE_BUILTINS = {
  unlink: 1,
  mkdir: 1,
  rmdir: 1,
  truncate: 1,
  rename: 2,
  symlink: 2,
  link: 2,
};

function analysePerl(toks, prog, roots, caps, writes, src) {
  const match = matchBrackets(toks);
  for (const spec of prog.preload ?? []) {
    const mod = spec.replace(/^-/, "").split("=")[0];
    if (!PERL_SAFE_MODULES.has(mod)) cap(caps, `loads the module ${mod}`);
  }
  if (src.includes("(?{") || src.includes("(??{") || src.includes("(*{"))
    cap(caps, "runs code inside a regular expression");
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (t.t === "str") {
      if (t.command) cap(caps, "runs a command (backticks or qx)");
      if (t.flags && /e.*e/.test(t.flags))
        cap(caps, "evaluates a substitution's result as code (s///ee)");
      continue;
    }
    if (t.t === "var") {
      if (t.v === "^I") cap(caps, "edits files in place ($^I)");
      // `\&CORE::readpipe`, `&CORE::open(...)`, `*CORE::GLOBAL::open = ...`: a builtin
      // reached as a code reference skips every check on its name.
      if ((t.sigil === "&" || t.sigil === "*") && /^(?:main)?(?:::)?CORE::/.test(t.v)) {
        cap(caps, `reaches the builtin ${t.v} as a code reference`);
      }
      continue;
    }
    if (isP(t, "*") && isP(next, "{")) cap(caps, "reaches a symbol by name (*{...})");
    if (
      isP(t, "&") &&
      (isP(next, "{") || isP(next, "$") || (next?.t === "var" && next.sigil === "$"))
    )
      cap(caps, "calls code through a reference built at run time");
    if (isP(t, "->") && (next?.t === "var" || isP(next, "$")))
      cap(caps, "calls a method chosen at run time");
    if (isP(t, "::") && isP(next, "{")) cap(caps, "reaches the symbol table");
    if (t.t !== "id") continue;
    const name = t.v.replace(/^CORE::(?:GLOBAL::)?/, "");
    if (isP(prev, "->")) {
      if (name === "can" || PERL_DANGER.has(name)) cap(caps, `calls the method ${name}`);
      continue;
    }
    if (isP(next, "=>")) continue; // a hash key
    if (isP(prev, "{") && isP(next, "}")) continue; // `$h{key}`
    if (name === "use" || name === "no" || (name === "require" && next?.t === "id")) {
      const mod = next?.t === "id" ? next.v : null;
      if (next?.t === "num") continue; // `use 5.010`
      if (mod === null) {
        cap(caps, `${name}s something the hook cannot name`);
        continue;
      }
      if ((mod === "parent" || mod === "base") && name !== "no") {
        cap(caps, `inherits from a module (${mod})`);
        continue;
      }
      if (!PERL_SAFE_MODULES.has(mod)) cap(caps, `${name}s the module ${mod}`);
      i += 1;
      continue;
    }
    if (name === "require") {
      cap(caps, "requires a file or a name built at run time");
      continue;
    }
    if (name === "eval" || name === "do") {
      if (isP(next, "{")) continue; // a block
      cap(caps, name === "eval" ? "evaluates a string as code" : "runs a file or a string (do)");
      continue;
    }
    if (name === "open") {
      perlOpen(toks, i, match, caps, writes);
      continue;
    }
    if (PERL_WRITE_BUILTINS[name] !== undefined) {
      const args =
        (isP(next, "(") ? callArgs(toks, i + 1, match) : perlBareArgs(toks, i + 1, match)) ?? [];
      const want = PERL_WRITE_BUILTINS[name];
      const pathArgs = name === "mkdir" || name === "truncate" ? args.slice(0, 1) : args;
      const paths = pathArgs.map(([a, z]) => literalAt(toks, a, z));
      if (paths.length === 0 || paths.length < want || paths.some((p) => p === null)) {
        cap(caps, `writes through ${name} to a path that is not a plain literal`);
      } else writes.push({ paths, what: name });
      continue;
    }
    if (PERL_DANGER.has(name) || PERL_DANGER.has(t.v)) cap(caps, `uses ${t.v}`);
  }
}

// Paren-less arguments are read at most this far (a longer list is not read, so refused).
const MAX_BARE_ARGS = 256;

function perlBareArgs(toks, at, match) {
  const args = [];
  let a = at;
  const stop = Math.min(toks.length, at + MAX_BARE_ARGS);
  for (let i = at; i < stop; i += 1) {
    const t = toks[i];
    if (t.t === "p" && (t.v === "(" || t.v === "[" || t.v === "{") && match[i] > i) {
      i = match[i];
      continue;
    }
    if (t.t === "p" && (t.v === ";" || t.v === ")" || t.v === "}")) break;
    if (t.t === "id" && /^(?:or|and|if|unless|for|foreach|while|until)$/.test(t.v)) break;
    if (t.t === "p" && (t.v === "," || t.v === "=>")) {
      args.push([a, i]);
      a = i + 1;
    }
  }
  if (stop < toks.length && stop - at >= MAX_BARE_ARGS) return null;
  let end = a;
  while (end < stop) {
    const t = toks[end];
    if (
      (t.t === "p" && (t.v === ";" || t.v === ")" || t.v === "}")) ||
      (t.t === "id" && /^(?:or|and|if|unless|for|foreach|while|until)$/.test(t.v))
    )
      break;
    end += 1;
  }
  if (end > a) args.push([a, end]);
  return args;
}

function perlOpen(toks, i, match, caps, writes) {
  const args = isP(toks[i + 1], "(")
    ? callArgs(toks, i + 1, match)
    : perlBareArgs(toks, i + 1, match);
  if (!args || args.length < 2) {
    cap(caps, "calls open in a form the hook cannot read");
    return;
  }
  const lit = (r) => (r ? literalAt(toks, r[0], r[1]) : null);
  const handleTok = toks[args[args.length - 1][0]];
  if (args.length >= 3) {
    const mode = lit(args[1]);
    if (mode === null) {
      cap(caps, "calls open with a mode that is not a plain literal");
      return;
    }
    const m = mode.trim();
    if (/^<(?::[\w()-]+)*$/.test(m)) return; // a read
    if (/^[<>]&=?$/.test(m)) {
      if (handleTok.t === "id" && /^(?:STDOUT|STDERR|STDIN)$/.test(handleTok.v)) return;
      cap(caps, "duplicates a handle the hook cannot follow");
      return;
    }
    if (/^(?:\+?>>?|\+<)(?::[\w()-]+)*$/.test(m)) {
      const path = lit(args[2]);
      if (path === null) cap(caps, "opens for writing a path that is not a plain literal");
      else writes.push({ paths: [path], what: "open" });
      return;
    }
    cap(caps, `opens with the mode ${m} (a pipe or a mode the hook does not allow)`);
    return;
  }
  const specText = lit(args[1]);
  if (specText === null) {
    cap(caps, "opens a path that is not a plain literal (it could be a pipe)");
    return;
  }
  const spec = specText.trim();
  if (spec.startsWith("|") || spec.endsWith("|")) {
    cap(caps, "opens a pipe to a command");
    return;
  }
  if (/^[<>]&/.test(spec)) {
    if (/^[<>]&=?(?:STDOUT|STDERR|STDIN|[012])$/.test(spec)) return;
    cap(caps, "duplicates a handle the hook cannot follow");
    return;
  }
  const w = /^(\+?>>?|\+<)\s*(.*)$/s.exec(spec);
  if (w) {
    writes.push({ paths: [w[2]], what: "open" });
    return;
  }
  // `<path` or a bare path: a read.
}

// ---------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------
const PHP_DANGER = new Set(
  (
    "system exec shell_exec passthru proc_open popen pcntl_exec pcntl_fork mail mb_send_mail " +
    "putenv dl eval assert create_function chgrp lchown lchgrp chown tempnam tmpfile " +
    "move_uploaded_file chdir chroot fsockopen pfsockopen stream_socket_client " +
    "stream_socket_server socket_create socket_connect curl_init curl_exec curl_multi_exec " +
    "ftp_connect ssh2_connect imap_open error_log ini_set ini_alter set_include_path unserialize " +
    "posix_kill posix_mkfifo posix_setuid posix_setgid proc_nice proc_terminate apache_setenv " +
    "ffi splfileobject spltempfileobject pdo mysqli sqlite3 reflectionfunction reflectionmethod " +
    "reflectionclass ziparchive phar phardata fromcallable stream_wrapper_register " +
    "register_shutdown_function register_tick_function header_register_callback get_defined_functions"
  ).split(" "),
);
// Functions that call a callable they are given: allowed only with a closure.
const PHP_CALLABLE_TAKERS = new Set(
  (
    "call_user_func call_user_func_array forward_static_call forward_static_call_array " +
    "set_error_handler set_exception_handler spl_autoload_register iterator_apply array_map " +
    "array_filter array_walk array_walk_recursive array_reduce usort uasort uksort " +
    "preg_replace_callback preg_replace_callback_array ob_start"
  ).split(" "),
);
const PHP_WRITES = {
  file_put_contents: 1,
  unlink: 1,
  mkdir: 1,
  rmdir: 1,
  touch: 1,
  chmod: 1,
  rename: 2,
  copy: 2,
  symlink: 2,
  link: 2,
};
// More functions that write a file, open one for writing, or start something, by name.
const PHP_MORE_WRITES = new Set(
  (
    "gzopen gzwrite gzputs bzopen bzwrite xmlwriter_open_uri imagepng imagejpeg imagegif " +
    "imagewebp imagebmp imagewbmp imagexbm imageavif imagegd imagegd2 image2wbmp iptcembed " +
    "dio_open fputcsv fwrite fputs ftruncate flock tmpfile"
  ).split(" "),
);
// Methods that write a file when given a path (`$xml->asXML("/x")`, `$dom->save("/x")`).
const PHP_WRITE_METHODS = new Set(
  (
    "save savehtmlfile asxml savexml openfile openuri extractto writeimage writeimages " +
    "writeimagefile compress decompress buildfromdirectory buildfromiterator addfile"
  ).split(" "),
);
const PHP_DANGER_CLASSES = new Set(
  "splfileinfo xmlwriter domdocument simplexmlelement imagick gmagick".split(" "),
);
const PHP_URL_READS = new Set([
  "file_get_contents",
  "file",
  "readfile",
  "fopen",
  "get_headers",
  "simplexml_load_file",
  "parse_ini_file",
  "highlight_file",
  "show_source",
]);

function analysePhp(toks, prog, roots, caps, writes) {
  const match = matchBrackets(toks);
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (t.t === "str") {
      if (t.command) cap(caps, "runs a command (backticks)");
      else if (
        t.exact &&
        (PHP_DANGER.has(t.v.toLowerCase()) ||
          PHP_CALLABLE_TAKERS.has(t.v.toLowerCase()) ||
          PHP_WRITES[t.v.toLowerCase()] !== undefined ||
          PHP_MORE_WRITES.has(t.v.toLowerCase().replace(/^\\/, "")) ||
          PHP_URL_READS.has(t.v.toLowerCase().replace(/^\\/, "")))
      )
        cap(caps, `names the function ${t.v} in a string (a callable)`);
      if (isP(next, "(")) cap(caps, "calls a string as a function");
      continue;
    }
    if (t.t === "var" && isP(next, "(")) {
      cap(caps, "calls a variable function");
      continue;
    }
    if (isP(t, "->") && (next?.t === "var" || isP(next, "{") || isP(next, "$"))) {
      cap(caps, "calls a method chosen at run time");
      continue;
    }
    if ((isP(t, ")") || isP(t, "]") || isP(t, "}")) && isP(next, "(")) {
      cap(caps, "calls the result of an expression");
      continue;
    }
    if (t.t !== "id") continue;
    // `\file_put_contents` and `namespace\file_put_contents` name the global function.
    const name = t.v
      .toLowerCase()
      .replace(/^\\/, "")
      .replace(/^namespace\\/, "");
    if (isP(prev, "->") || isP(prev, "::")) {
      if (name === "fromcallable") cap(caps, "builds a closure from a callable");
      else if (PHP_WRITE_METHODS.has(name) && isP(next, "(") && !isP(toks[i + 2], ")")) {
        cap(caps, `writes through the method ${t.v}()`);
      }
      continue;
    }
    if (name === "new") {
      const cls = next?.t === "id" ? next.v.toLowerCase().replace(/^\\/, "") : null;
      if (cls === null) cap(caps, "creates an object of a class chosen at run time");
      else if (PHP_DANGER.has(cls) || PHP_DANGER_CLASSES.has(cls)) cap(caps, `creates ${next.v}`);
      continue;
    }
    if (name === "use" && next?.t === "id" && /^(?:function|const)$/i.test(next.v)) {
      // `use function file_put_contents as f;`: an alias hides the name from every check.
      cap(caps, "imports a function under another name (use function)");
      continue;
    }
    if (/^(?:include|include_once|require|require_once)$/.test(name)) {
      const a = isP(next, "(") ? i + 2 : i + 1;
      const lit = literalAt(toks, a, a + 1);
      if (lit === null) cap(caps, `${name}s a file named at run time`);
      else if (lit.includes("://") || lit.startsWith("/")) {
        cap(caps, `${name}s ${lit.slice(0, 40)} (a stream or input, not a file)`);
      }
      continue;
    }
    if (PHP_MORE_WRITES.has(name) && isP(next, "(")) {
      if (
        name === "fwrite" ||
        name === "fputs" ||
        name === "fputcsv" ||
        name === "ftruncate" ||
        name === "flock"
      ) {
        // Writing to an open handle: only STDOUT / STDERR (the handle's open was judged).
        const h = toks[i + 2];
        if (!(h?.t === "id" && /^(?:STDOUT|STDERR)$/.test(h.v)) && !(h?.t === "var")) {
          cap(caps, `writes through ${t.v} to a handle the hook cannot follow`);
        }
        continue;
      }
      cap(caps, `uses ${t.v}, which writes files`);
      continue;
    }
    if (PHP_CALLABLE_TAKERS.has(name)) {
      if (!isP(next, "(")) continue;
      const close = match[i + 1];
      const inner = close > i && close - i < 2048 ? toks.slice(i + 2, close) : [];
      if (
        !inner.some(
          (x) => x.t === "id" && (x.v.toLowerCase() === "function" || x.v.toLowerCase() === "fn"),
        )
      ) {
        cap(caps, `calls ${name} with a callable that is not a closure`);
      }
      continue;
    }
    if (PHP_DANGER.has(name)) {
      cap(caps, `uses ${t.v}`);
      continue;
    }
    if (!isP(next, "(")) continue;
    const args = callArgs(toks, i + 1, match);
    const lit = (r) => (r ? literalAt(toks, r[0], r[1]) : null);
    if (name === "fopen") {
      const path = lit(args[0]);
      const mode = lit(args[1]);
      if (mode !== null && /^r[bt]?$/.test(mode)) {
        if (path === null || /^[a-z][\w+.-]*:\/\//i.test(path))
          cap(caps, "opens a path that may be a URL");
        continue;
      }
      if (path !== null && /^php:\/\/(?:stdout|stderr|output|memory|temp)$/.test(path)) continue;
      if (mode === null) cap(caps, "calls fopen with a mode that is not a plain literal");
      else if (path === null || path.includes("://"))
        cap(caps, "writes through fopen to a path that is not a plain literal");
      else writes.push({ paths: [path], what: "fopen" });
      continue;
    }
    if (PHP_URL_READS.has(name)) {
      const path = lit(args[0]);
      if (path === null || (/^[a-z][\w+.-]*:\/\//i.test(path) && !/^php:\/\/stdin$/.test(path))) {
        cap(caps, `reads through ${name} a path that may be a URL (the network)`);
      }
      continue;
    }
    const n = PHP_WRITES[name];
    if (n !== undefined) {
      // copy() reads its source and writes only its destination.
      const paths = (name === "copy" ? args.slice(1, 2) : args.slice(0, n)).map(lit);
      if (
        paths.length === 0 ||
        paths.length < (name === "copy" ? 1 : n) ||
        paths.some((p) => p === null || p.includes("://"))
      ) {
        cap(caps, `writes through ${name} to a path that is not a plain literal`);
      } else writes.push({ paths, what: name });
    }
  }
}

// ---------------------------------------------------------------------
// THE RULE
// ---------------------------------------------------------------------
const ANALYSERS = {
  python: analysePython,
  js: analyseJs,
  ruby: analyseRuby,
  perl: analysePerl,
  php: analysePhp,
};

/** Why one inline program is refused, or null; its allowed write targets go to `targets`. */
function programReason(prog, roots, targets) {
  const lang = prog.lang;
  // Output paths of a command line the shell layer read (`python -m venv DIR`).
  if (lang === "writes") return writePathsReason(prog.paths, prog.cwd, roots, prog.what, targets);
  const variants = lang === "perl" ? [{ perlTick: false }, { perlTick: true }] : [{}];
  for (const opts of variants) {
    const lexed = lexProgram(lang, prog.text, opts);
    if (lexed.error) return `cannot be read by the hook (${lexed.error})`;
    const caps = [];
    const writes = [];
    ANALYSERS[lang](lexed.tokens, prog, roots, caps, writes, prog.text);
    if (caps.length) return caps[0];
    const textWhy = textWordReason(lang, prog.text, lexed.mask);
    if (textWhy) return textWhy;
    for (const w of writes) {
      const why = writePathsReason(w.paths, prog.cwd, roots, w.what, targets);
      if (why) return why;
    }
  }
  return null;
}

/**
 * The capability rule for inline programs: { reason, targets }. A program that cannot
 * be seen, or that shows any file-writing, process, network or dynamic-code capability
 * other than a write to a literal path inside a write root, is refused (`reason`). The
 * literal paths an allowed program writes are returned (`targets`, absolute) so the
 * caller judges them like a Bash write target (.git internals, the agent settings, the
 * git execution surface, secret files).
 */
function inlineCapability(cmd, roots) {
  const { programs, reasons } = inlinePrograms(cmd);
  const targets = [];
  if (reasons.length) {
    return {
      reason: `inline interpreter program the hook cannot see (${reasons[0]}): ${ADVICE}`,
      targets,
    };
  }
  for (const prog of programs) {
    const why = programReason(prog, roots, targets);
    if (why) return { reason: `inline ${prog.via} program ${why}: ${ADVICE}`, targets };
  }
  const unique = [...new Set(targets)];
  if (unique.length > MAX_INLINE_WRITE_TARGETS) {
    // Each target is judged like a Bash write target; bound that work.
    return {
      reason: `inline interpreter programs write more than ${MAX_INLINE_WRITE_TARGETS} files in one command: ${ADVICE}`,
      targets: [],
    };
  }
  return { reason: null, targets: unique };
}

// The read primitives above with their unbounded `[^,]*` scans bounded, so a long
// program costs linear time here.
const BOUNDED_READ_PATTERNS = READ_PRIMITIVE_PATTERNS.map(
  (re) => new RegExp(re.source.split("[^,]*").join("[^,]{0,256}"), re.flags + "g"),
);

/**
 * The read rules over the normalised program text: the read primitives of the read
 * boundary above (when roots are configured), and a decoded string that names a secret
 * path (`"\x2eenv"` is `.env`). Only adds refusals.
 */
function inlineProgramReadReason(cmd, roots) {
  const { programs } = inlinePrograms(cmd);
  for (const prog of programs) {
    if (prog.lang === "writes") continue;
    if (roots.configured) {
      for (const global of BOUNDED_READ_PATTERNS) {
        for (const m of prog.text.matchAll(global)) {
          const raw = m[1] ? stripQuotes(m[1]) : "";
          if (!raw || /[$`]|\$\{|#\{/.test(raw)) continue;
          if (!raw.startsWith("/") && prog.cwd === null) continue;
          let abs;
          try {
            abs = canonicalize(resolve(prog.cwd ?? "/", raw));
          } catch {
            return `inline interpreter reads a path too deep to resolve: ${raw.slice(0, 80)}`;
          }
          if (classifyRootAccess(abs, roots) === "outside") {
            return `inline interpreter reads a file outside allowed roots: ${raw} [write-roots: ${roots.writeRoots.join(", ")}; read-roots: ${roots.readRoots.join(", ")}]`;
          }
        }
      }
    }
    const lexed = lexProgram(prog.lang, prog.text);
    if (lexed.error) continue; // refused by the capability rule
    for (const t of lexed.tokens) {
      if (t.t !== "str" || !t.v || t.v.length > 4096) continue;
      for (const part of t.v.split(/[\s"'`,;()]+/)) {
        if (
          part &&
          (SECRET_PATH.test(part) || SECRET_PATH.test(part + "/")) &&
          !ENV_TEMPLATE.test(part)
        ) {
          return `inline interpreter program names a secret path (${part.slice(0, 80)})`;
        }
      }
    }
  }
  return null;
}

export {
  inlineCapability,
  inlineProgramReadReason,
  inlineReadBoundaryReason,
  inlineWriteBoundaryReason,
};
