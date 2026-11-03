/**
 * The inline-interpreter filesystem boundary: `python -c`, `node -e`, `ruby -e`,
 * `perl -e`, `php -r` and heredoc-fed programs, their write and read primitives.
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { resolve } from "node:path";
import { canonicalize, classifyRootAccess } from "./paths.mjs";

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

export { inlineReadBoundaryReason, inlineWriteBoundaryReason };
