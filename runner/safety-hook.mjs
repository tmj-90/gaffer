#!/usr/bin/env node
/**
 * Gaffer factory — Claude Code PreToolUse safety hook (the deterministic bouncer).
 *
 * Claude Code invokes this before a tool runs, passing the tool call as JSON on
 * stdin. Exit 0 = allow; exit 2 = BLOCK (stderr is fed back to the model as the
 * reason). This is the security boundary for unattended runs: the model proposes
 * actions, this hook decides — deterministically, not by trusting the model.
 *
 * Deny-by-default for the dangerous classes; everything else is allowed. Kept
 * self-contained (no imports) so a change elsewhere can never weaken it.
 *
 * Mirrors Crew's safety classifiers (git/fs/command) but is intentionally
 * duplicated here: a security control should not depend on another build.
 *
 * SECRET BOUNDARY MODEL (see the block below checkWrite): the secret-read guard
 * is NOT a denylist of reader binaries. It treats the *secret path* as the
 * protected thing and over-blocks whenever a shell construct hides the data
 * flow. HONEST RESIDUAL LIMITATION: a fully-dynamic path (assembled at runtime,
 * never appearing literally and not routed through a read-ish tool or `$(...)`)
 * can still slip past a regex. This hook is defence-in-depth, not a jail — real
 * containment of a determined exfil needs an OS sandbox / permission boundary.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Canonicalise a path symlink-safely, even when it doesn't exist yet (a file
 * about to be written): realpath the longest existing ancestor, then re-append
 * the not-yet-created tail. Fixes false "outside repo" blocks under symlinked
 * roots like macOS /tmp -> /private/tmp.
 */
function canonicalize(p) {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return resolve(canonicalize(parent), basename(p));
  }
}

// Captured at dispatch so a block can be logged with its tool/target context.
// Best-effort telemetry only — never read by the allow/block decision.
let CURRENT_TOOL = null;
let CURRENT_TARGET = null;

// Coarse category for the block ledger, derived from the reason string so the
// trust report can group "what the agent kept trying" without parsing prose.
function blockCategory(reason) {
  const r = String(reason).toLowerCase();
  if (r.includes("secret") || r.includes(".env") || r.includes("credential")) return "secret-read";
  if (
    r.includes("control plane") ||
    r.includes("dispatch") ||
    r.includes("memory") ||
    r.includes("review approve") ||
    r.includes("mark-merged")
  )
    return "control-plane";
  if (r.includes("force") && r.includes("push")) return "force-push";
  if (r.includes("ignore-scripts") || r.includes("install")) return "supply-chain";
  if (
    r.includes("crontab") ||
    r.includes("launchctl") ||
    r.includes("hookspath") ||
    r.includes("git config") ||
    r.includes("fsmonitor") ||
    r.includes("sshcommand")
  )
    return "execution-hijack";
  if (
    r.includes("outside") ||
    r.includes("write-root") ||
    r.includes("write root") ||
    r.includes("scope") ||
    r.includes("unverifiable")
  )
    return "out-of-scope-write";
  return "other";
}

// Append one block to the structured ledger ($GAFFER_DATA/safety-blocks.jsonl).
// Gated on GAFFER_DATA so the test harness (which doesn't set it) is unaffected,
// and fully swallowed so a logging failure can never change the security
// decision or fail the hook. This is the data behind the end-of-run trust report.
function logBlock(reason) {
  try {
    const dir = process.env.GAFFER_DATA;
    if (!dir) return;
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      ticket: process.env.GAFFER_TICKET || null,
      tool: CURRENT_TOOL,
      category: blockCategory(reason),
      reason: String(reason).slice(0, 300),
      target: CURRENT_TARGET ? String(CURRENT_TARGET).slice(0, 240) : null,
    });
    appendFileSync(join(dir, "safety-blocks.jsonl"), entry + "\n");
  } catch {
    /* best-effort telemetry — must never affect the decision or fail the hook */
  }
}

function block(reason) {
  logBlock(reason);
  process.stderr.write(`BLOCKED by gaffer safety hook: ${reason}\n`);
  process.exit(2);
}
function allow() {
  process.exit(0);
}

// =====================================================================
// REPO-ACCESS BOUNDARY (FG-007) — write-roots / read-roots enforcement
// ---------------------------------------------------------------------
// Repo boundaries must NOT be prompt-only. The runtime is told, via env,
// the exact set of repos it may WRITE to and the set it may additionally
// READ from. This hook then deterministically enforces:
//   • Writes (file tools + bash write ops) only inside a WRITE root.
//   • A write whose target is inside a READ root, or outside all roots,
//     is DENIED ("write outside write-roots").
//   • Reads only inside (write-roots ∪ read-roots); reads fully outside
//     are denied (UNLESS already allowed by the pre-existing rules —
//     the secret / dangerous-command denials still take precedence).
//   • Branch creation only when cwd/target is inside a WRITE root.
//
// Env contract (both accept newline- OR colon-separated absolute paths):
//   GAFFER_WRITE_ROOTS   repos the agent may write to (and branch in).
//   GAFFER_READ_ROOTS    extra repos the agent may read (never write).
//
// FALLBACK (both unset/empty): preserve TODAY's behaviour — treat the
// cwd repo as the single write-root. This is never MORE permissive than
// the historical "no writes outside the ticket's repo" rule.
// =====================================================================

/** Split a roots env var on newlines or colons; canonicalize each entry. */
function parseRoots(value) {
  if (!value) return [];
  return value
    .split(/[\n:]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => canonicalize(resolve(p)));
}

/**
 * True when `target` resolves at, or strictly under, `root`. Both are
 * canonicalised (realpath of the longest existing ancestor) so symlinked
 * roots and not-yet-created tails compare correctly, and a `..` escape that
 * lands outside the root fails the prefix test.
 */
function isInsideRoot(root, target) {
  return target === root || target.startsWith(root + "/");
}

/** True when `target` is inside ANY of `roots`. */
function isInsideAny(roots, target) {
  return roots.some((root) => isInsideRoot(root, target));
}

/**
 * Resolve the effective write/read roots from the environment, applying the
 * single-repo fallback when both are empty. Read access is always the UNION
 * of write-roots and read-roots (you can read what you can write).
 */
function resolveRoots() {
  const writeRoots = parseRoots(process.env.GAFFER_WRITE_ROOTS);
  const readRoots = parseRoots(process.env.GAFFER_READ_ROOTS);
  if (writeRoots.length === 0 && readRoots.length === 0) {
    // Fallback: today's behaviour — the cwd repo is the only write-root, and
    // reads are NOT root-restricted (only the secret denial applied historically).
    // `configured: false` tells checkRead to skip read-root enforcement so the
    // fallback is never MORE restrictive on reads than today.
    return { writeRoots: [canonicalize(process.cwd())], readRoots: [], configured: false };
  }
  return { writeRoots, readRoots, configured: true };
}

/**
 * Classify an absolute, canonicalised path against the resolved roots.
 * Returns "write" (inside a write-root), "read" (inside a read-root but not a
 * write-root), or "outside" (inside neither).
 */
function classifyRootAccess(absPath, { writeRoots, readRoots }) {
  if (isInsideAny(writeRoots, absPath)) return "write";
  if (isInsideAny(readRoots, absPath)) return "read";
  return "outside";
}

// Secret-bearing / sensitive paths — never written, never read (keeps secrets
// out of the model's context window too). Anchored to end-of-path for the
// Read/Write file checks below.
const SECRET_PATH =
  /(^|\/)(\.env(\.[\w-]+)?|\.netrc|\.npmrc|\.git-credentials|id_[a-z0-9]+|.*\.pem|.*\.key|.*\.p12|credentials|secrets?\.(json|ya?ml|txt))$/i;
const GIT_INTERNAL = /(^|\/)\.git(\/|$)/;

// =====================================================================
// CONTENTS-LEAVING / PATH-REFERENCE BOUNDARY (re-architected)
// ---------------------------------------------------------------------
// The old model enumerated "reader" binaries (cat/sed/awk/…) and denied
// when one named a secret path. That is a DENYLIST and it leaks: any
// non-enumerated reader (`sort .env`, `column .env`, `openssl enc -in
// .env`), shell builtins (`<`, `source`, `.`, `read`, `mapfile`), globs
// (`cat .en*`), var indirection (`f=.env; cat "$f"`), and command
// substitution (`cat "$(echo ... | base64 -d)"`) all sail through.
//
// New model — stop enumerating readers. Instead treat the SECRET PATH as
// the thing to protect and over-block when a shell construct hides the
// data flow:
//   1. If a secret-path fragment appears ANYWHERE in the command, deny —
//      unless it appears ONLY in a clearly-safe governed position
//      (a bare `git add`/`rm` of that path, handled by other rules).
//   2. Treat `<` redirect and `source`/`.` of a secret path as reads.
//   3. Flag glob/wildcard tokens whose literal prefix/suffix overlaps a
//      secret family (`.e*`, `.env*`, `id_*`, `*.pem`, `*credential*`).
//   4. When a pipe / `xargs` / command-substitution `$(...)` / backticks
//      appears AND a secret fragment appears anywhere → deny.
//   5. Command substitution can hide the path entirely (base64-decoded),
//      so conservatively deny ANY command that combines command-
//      substitution with a read-ish tool, even with no visible secret.
//      This is defence-in-depth, not a jail: a fully-dynamic path still
//      needs a real sandbox. We document that honestly below.
// =====================================================================

// Secret-path fragment for matching anywhere inside a raw shell command
// string (not anchored to end-of-path — a command can reference the path
// mid-line, in quotes, as an argument, etc.). Covers the same families as
// SECRET_PATH plus directory-style markers (.ssh/, .aws/).
const SECRET_PATH_FRAGMENT =
  /(\.env\b|\.env\.[\w-]+|[\w./-]*\.pem\b|[\w./-]*\.key\b|[\w./-]*\.p12\b|id_rsa\b|id_ed25519\b|id_[a-z0-9]+\b|\.ssh\/|\.aws\/|\.npmrc\b|\.git-credentials\b|\.netrc\b|\.gnupg\/|credentials\b|secrets?\b)/i;

// Glob/wildcard tokens whose literal part overlaps a secret family. These
// resolve to secret paths at runtime even though no full secret name is
// written literally (`.en*`, `.e?v`, `.en[v]`, `id_*`, `*.pem`, `*.key`,
// `*credential*`, `*secret*`). We match the wildcard form specifically so
// an ordinary glob like `*.ts` or `src/*` is not flagged.
const SECRET_GLOB =
  /(\.e[*?]|\.en[*?]|\.env[*?]|\.e\[|\.en\[|id_[*?]|id_\[|[*?][\w.]*\.pem\b|[*?][\w.]*\.key\b|[*?][\w.]*\.p12\b|[*?][\w./-]*credential|[*?][\w./-]*secret|credential[\w./-]*[*?]|secret[\w./-]*[*?])/i;

// Shell read/redirect/source positions that consume a file's CONTENTS
// without naming a "reader" binary:
//   `< .env`        input redirection
//   `source .env` / `. .env`   load secrets into the environment
//   `read ... < .env` / `mapfile < .env`  (the `<` rule catches these too)
const REDIRECT_READ =
  /<\s*["']?[\w./~$-]*(\.env|\.pem|\.key|\.p12|id_rsa|id_ed25519|\.ssh\/|\.aws\/|\.npmrc|\.git-credentials|\.netrc|credentials|secrets?)/i;
const SOURCE_SECRET =
  /(^|[\n;&|])\s*(source|\.)\s+["']?[\w./~$-]*(\.env|\.pem|\.key|\.p12|id_rsa|id_ed25519|\.ssh\/|\.aws\/|\.npmrc|\.git-credentials|\.netrc|credentials|secrets?)/i;

// Command-substitution / pipe / xargs constructs that decouple the tool
// from the path it operates on, hiding the data flow from static analysis.
const COMMAND_SUBSTITUTION = /\$\([^)]*\)|`[^`]*`/;
const PIPE_OR_XARGS = /\||\bxargs\b/;

// Read-ish tools — used ONLY for the conservative command-substitution
// over-block (rule 5). This is no longer the primary gate; it is a
// belt-and-braces signal for "this segment moves file contents". Kept
// broad on purpose (a denylist here only ADDS denials, never removes the
// path-fragment denial that does the real work).
const READISH_TOOL =
  /\b(cat|head|tail|less|more|bat|sed|awk|nl|tac|cut|sort|uniq|column|fmt|paste|join|comm|expand|unexpand|fold|pr|rev|grep|egrep|fgrep|rg|ag|ack|strings|xxd|od|hexdump|base64|base32|xxencode|uuencode|openssl|ssh-keygen|gpg|cp|mv|scp|rsync|sftp|tar|cpio|dd|tee|curl|wget|nc|ncat|socat|mail|mailx|sendmail)\b/i;

// Interpreters that can read a file via an inline program (-c / -e / -ne / -pe …).
const INLINE_INTERPRETER =
  /\b(python3?|perl|ruby|node|deno|bun|php|bash|sh|zsh)\b[^\n]*\s-(c|e|ne|pe|Ee?)\b/i;
const FILE_READ_PRIMITIVE =
  /(readFileSync|readFile|read_text|File\.read|open\s*\(|fopen\s*\(|IO\.read|Get-Content)/i;

// Variable indirection: `f=.env` (or `f=~/.ssh/id_rsa`) assigns a secret
// path to a variable, which a later command then dereferences via `$f`.
// We can't follow the dataflow, so any secret-path assignment is treated
// as a read boundary unless the whole command is a single safe governed op.
const SECRET_ASSIGNMENT =
  /\b[\w]+=["']?[\w./~$-]*(\.env\b|\.pem\b|\.key\b|\.p12\b|id_rsa\b|id_ed25519\b|\.ssh\/|\.aws\/|\.npmrc\b|\.git-credentials\b|\.netrc\b|credentials\b|secrets?\b)/i;

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
];
const NODE_WRITE_PRESENCE = [
  /\b(?:fs\.)?(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(/,
  /\b(?:fs\.)?openSync\s*\([^)]*,\s*["'`][^"'`]*[waWA]/,
  /\b(?:fs\.)?(?:cpSync|copyFileSync|renameSync)\s*\(/,
];
const RUBY_WRITE_PRESENCE = [
  /\b(?:File|IO)\.write\s*\(/,
  /\bFile\.open\s*\([^)]*,\s*["'][^"']*[waWA]/,
  /\b(?:FileUtils\.(?:cp|mv|copy|move)|File\.rename)\b/,
];
const PERL_WRITE_PRESENCE = [
  /\bopen\s*\([^,]*,\s*["']\+?>>?/, // open(FH, '>'|'>>', …) or open(FH, ">…")
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
  /\b(?:File|IO)\.write\s*\(\s*(["'][^"']*["'])/,
  /\bFile\.open\s*\(\s*(["'][^"']*["'])\s*,\s*["'][^"']*[waWA]/,
];
const PERL_WRITE_LITERALS = [
  // 3-arg form: open(FH, '>'|'>>', 'path')  → capture the path (3rd arg).
  /\bopen\s*\([^,]*,\s*["']\+?>>?["']\s*,\s*(["'][^"']*["'])/,
  // 2-arg fused form: open(FH, ">path") — mode and path share one quoted
  // string. Capture the path WITHOUT the redirect prefix (no $ interpolation
  // → literal). We re-wrap in a sentinel quote so the shared stripQuotes/
  // classify path works; the leading >>? and any whitespace are dropped.
  /\bopen\s*\(\s*[^,]*,\s*["']\+?>>?\s*([^"'$>][^"'$]*)["']/,
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

// Plain read tools (cat/sed/grep/…) whose LITERAL target path lands outside
// (write ∪ read) roots must be blocked when roots are configured (P1). This is
// the read-side counterpart to extractBashWriteTargets. We list the read tools
// explicitly (this is an additive ALLOWLIST of "tools that consume a path
// argument as input"); the secret-path guard above still takes precedence and
// fires first for any secret target.
const READ_TOOL_VERBS = new Set([
  "cat",
  "sed",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "awk",
  "head",
  "tail",
  "less",
  "more",
  "od",
  "xxd",
  "nl",
  "strings",
  "hexdump",
  "tac",
  "bat",
]);

// Dangerous shell patterns (checked against the raw command string).
const DENY_COMMANDS = [
  { re: /git\s+push\b[^\n|;&]*(--force\b|--force-with-lease\b|\s-f\b|\s\+)/, why: "force push" },
  {
    re: /git\s+push\b[^\n|;&]*\b(origin\s+)?(main|master|release|production|prod)\b/,
    why: "push to a protected branch",
  },
  { re: /git\s+push\b[^\n|;&]*--delete\b/, why: "remote branch/tag deletion" },
  { re: /git\s+(branch\s+-D|tag\s+-d)\b/, why: "branch/tag force-deletion" },
  { re: /git\s+reset\s+--hard\b/, why: "hard reset" },
  {
    re: /git\s+clean\s+-[a-z]*f[a-z]*d|git\s+clean\s+-[a-z]*d[a-z]*f/,
    why: "git clean -fd (destructive)",
  },
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, why: "rm -rf" },
  {
    re: /\b(curl|wget)\b[^\n|;&]*\|\s*(sh|bash|zsh)\b/,
    why: "pipe-to-shell of a downloaded script",
  },
  // `install: true` tags the ONE rule the bootstrap allowance may relax (see
  // bootstrapInstallAllowed). brew/sudo are NOT tagged, so they stay blocked even
  // during a bootstrap tick — only package-manager installs into the fresh repo
  // are ever permitted.
  {
    re: /\b(npm|pnpm|yarn)\s+(i\b|install\b|add\b)|\bpip\d?\s+install\b/,
    why: "dependency install (needs human approval)",
    install: true,
  },
  { re: /\bbrew\s+install\b/, why: "dependency install (needs human approval)" },
  { re: /\bsudo\b/, why: "sudo" },
  // `find … -delete` and `find … -exec rm|sh|bash …` recursively destroy or
  // run arbitrary commands over a tree — deny regardless of where the tree is.
  { re: /\bfind\b[^\n]*\s-delete\b/, why: "find -delete (destructive tree walk)" },
  {
    re: /\bfind\b[^\n]*\s-exec(?:dir)?\s+(?:rm|sh|bash|zsh|dash)\b/,
    why: "find -exec rm/shell (destructive tree walk)",
  },
  // Whole-file truncation/erasure primitives. `truncate`'s target is ALSO routed
  // through the write-target extractor (so an in-root truncate is judged there);
  // `shred` always destroys, so it is blanket-denied here.
  { re: /\bshred\b/, why: "shred (irrecoverable file erase)" },
  // Git config keys that hijack execution or hook behaviour: pointing hooksPath
  // at attacker files, swapping fsmonitor/sshCommand to run a payload, or
  // installing an alias that shells out. Match `git [-C dir] config … <key>`.
  {
    re: /\bgit\b[^\n|;&]*\bconfig\b[^\n|;&]*\b(core\.hooksPath|core\.fsmonitor|core\.sshCommand|alias\.[\w-]+)\b/,
    why: "git config of an execution-hijacking key (hooksPath/fsmonitor/sshCommand/alias)",
  },
  // Scheduled-execution / service-loading primitives — a way to persist or run
  // code out of band of this hook.
  { re: /\bcrontab\b/, why: "crontab (scheduled execution)" },
  { re: /\bat\s+(?:-f\b|now\b|[0-9])/, why: "at (scheduled execution)" },
  { re: /\blaunchctl\s+(?:load|bootstrap)\b/, why: "launchctl load/bootstrap (service loading)" },
  // CONTROL-PLANE BYPASS (backstops the authz P0). The agent must reach Dispatch
  // ONLY through the scoped MCP server — never the privileged CLI and never the
  // raw database. The CLI can mint a human-grade approval, mark a ticket merged,
  // reject, or grant repo access; the MCP surface the agent is given cannot. Block
  // every privileged `wg|dispatch|fg|crew` write subcommand from agent Bash.
  // Read-only inspection (`wg ticket show`, `wg ticket list`) stays allowed so the
  // agent can still look things up; only the state-changing verbs are denied.
  {
    re: /\b(wg|dispatch|fg|crew)\b[^\n|;&]*\b(review|approve|approve-ready|mark-merged|reject|repo-access)\b/,
    why: "control-plane CLI write (use the scoped MCP, not the privileged wg/dispatch/fg/crew CLI)",
  },
  // Raw DB access: sqlite3 (or a node CLI) operating on the Dispatch/Memory
  // database file bypasses the MCP entirely. Match a sqlite3/node invocation whose
  // text references the configured DB path (or any *dispatch*/*memory* .sqlite).
  {
    re: /\bsqlite3\b[^\n|;&]*(?:\$\{?(?:DISPATCH_DB|MEMORY_DB)\}?|[^\s'"]*(?:dispatch|memory)[^\s'"]*\.sqlite\b)/i,
    why: "raw sqlite3 on the Dispatch/Memory database (use the scoped MCP, not the raw DB)",
  },
  {
    re: /\bnode\b[^\n|;&]*(?:dispatch|crew)[^\n|;&]*\/(?:dist\/)?cli\b/i,
    why: "raw node CLI invocation of the Dispatch/Crew control plane (use the scoped MCP)",
  },
];

// =====================================================================
// BOOTSTRAP-ONLY INSTALL ALLOWANCE (greenfield create-a-repo mode)
// ---------------------------------------------------------------------
// Installs are a HARD user rule: blocked everywhere, always — EXCEPT the one
// case a greenfield bootstrap genuinely needs: the FIRST `npm/pnpm/yarn install`
// in the brand-new repo the bootstrap ticket just created. The runner signals
// this, FOR THAT TICK ONLY, with two env vars:
//   GAFFER_BOOTSTRAP_INSTALL=1     — this tick is a bootstrap delivery
//   GAFFER_BOOTSTRAP_DIR=<absdir>  — the fresh repo dir the install must target
// The relaxation is intentionally NARROW: it applies ONLY to the install-tagged
// DENY rule, ONLY when the flag is set, AND ONLY when the command runs inside the
// bootstrap dir (cwd is inside it, and the command does not `cd` out of it). Every
// other blocked op (brew, sudo, rm -rf, force-push, secret reads, writes/reads
// outside roots) stays fully gated. A plain `npm install` with no flag, or one
// outside the bootstrap dir, is still BLOCKED.
function bootstrapInstallAllowed(cmd) {
  if (process.env.GAFFER_BOOTSTRAP_INSTALL !== "1") return false;
  const dir = process.env.GAFFER_BOOTSTRAP_DIR;
  if (!dir) return false;
  const bootDir = canonicalize(resolve(dir));
  // The command must run inside the bootstrap repo dir: cwd is inside it…
  const cwd = canonicalize(process.cwd());
  if (!isInsideRoot(bootDir, cwd)) return false;
  // …and the command must not relocate to a directory OUTSIDE the bootstrap dir
  // before installing (e.g. `cd /elsewhere && npm install`). A `cd` to a path
  // that does not resolve inside the bootstrap dir voids the allowance.
  const cdRe = /\bcd\s+([^\s;&|]+)/g;
  let m;
  while ((m = cdRe.exec(cmd)) !== null) {
    const dest = stripQuotes(m[1]);
    if (!dest) continue;
    const destAbs = canonicalize(resolve(cwd, dest));
    if (!isInsideRoot(bootDir, destAbs)) return false;
  }
  return true;
}

// =====================================================================
// SUPPLY-CHAIN: --ignore-scripts ON EVERY PERMITTED INSTALL (P0 ACE)
// ---------------------------------------------------------------------
// A package install that runs dependency LIFECYCLE scripts (preinstall /
// install / postinstall) is arbitrary code execution: the agent types
// `pnpm install` and an attacker-published (or typosquatted) dependency's
// postinstall runs unsandboxed. Even the ONE install the bootstrap allowance
// permits must not run lifecycle scripts. So the rule is: an install command
// the factory would otherwise permit (a scoped bootstrap install) is BLOCKED
// unless it carries `--ignore-scripts`. tick.sh additionally exports
// npm_config_ignore_scripts=true for the bootstrap invocation as a belt-and-
// braces env-level kill switch, but we ALSO require the explicit flag so the
// guarantee does not depend on an env var the agent could unset mid-command.
//
// Covers npm / pnpm / yarn (their `install`/`i`/`add` forms all accept the
// flag). `--ignore-scripts=true` and `--ignore-scripts true` count; an explicit
// `--ignore-scripts=false` / `--no-ignore-scripts` does NOT (it re-enables
// scripts) and is treated as missing.
function installHasIgnoreScripts(cmd) {
  // Explicit re-enable forms void the guarantee — treat as NOT present.
  if (/--ignore-scripts(?:=|\s+)(?:false|0|no)\b/i.test(cmd)) return false;
  if (/--no-ignore-scripts\b/i.test(cmd)) return false;
  // Bare flag, or `--ignore-scripts=true`, or `--ignore-scripts true`.
  return /--ignore-scripts(?:\b(?!=)|=true\b|=1\b)/i.test(cmd);
}

// =====================================================================
// GIT SECRET-OP BOUNDARY
// ---------------------------------------------------------------------
// Git can leak or stage a secret through ordinary-looking subcommands:
//   READ  → `git diff .env` / `git show HEAD:.env` / `git log -p .env`
//           print secret contents straight into the model context.
//   STAGE → `git add .env` / `git stage .ssh/id_rsa` put a secret into the
//           index, ready to be committed and pushed.
// These must be DENIED. By contrast `git status .env`, `git rm --cached .env`,
// `git rm .env`, and `git ls-files .env` only act on the path metadata (never
// the contents) and stay ALLOWED.
//
// Two stateful cases can't be judged from the command text alone, so we do a
// best-effort `git -C <cwd>` inspection of the actual repo (wrapped in
// try/catch — if git is unavailable we fall back to the safe default):
//   `git add .` / `git add -A`  → DENY if an untracked/modified secret file
//                                  exists (it would be swept into the index).
//   `git commit …`              → DENY if a secret path is already STAGED.
// =====================================================================

// Git subcommands that, given a secret-path argument, READ its contents into
// the model context (diff/show/log -p) — always deny when a secret is named.
const GIT_READ_SUBCMD = /^git\s+(diff|show|log|blame|grep)\b/i;
// Git subcommands that STAGE a path into the index — deny when a secret is the
// explicit argument (add/stage). `git add .`/`-A` is handled separately by the
// stateful repo inspection below.
const GIT_STAGE_SUBCMD = /^git\s+(add|stage)\b/i;
// `git add .` / `git add --all` / `git add -A` — stages everything, so a secret
// argument isn't named but an untracked/modified secret would still be swept in.
const GIT_ADD_ALL = /^git\s+add\s+(?:-A\b|--all\b|\.(?:\s|$))/i;
// `git commit …` — committing what is already staged.
const GIT_COMMIT = /^git\s+commit\b/i;

/**
 * Best-effort repo inspection: does the repo at `cwd` currently have an
 * untracked/modified secret file (staged is included)? Used to decide `git
 * add .`/`-A`. Returns true (deny) if so. On any failure (git missing, not a
 * repo) returns false here and the caller applies its own fallback.
 */
function repoHasUnstagedOrModifiedSecret(cwd) {
  try {
    const res = spawnSync("git", ["-C", cwd, "status", "--porcelain", "-uall"], {
      encoding: "utf8",
      timeout: 4000,
    });
    if (res.status !== 0 || typeof res.stdout !== "string") return false;
    return res.stdout
      .split("\n")
      .map((line) => line.slice(3).trim()) // strip the 2-char status + space
      .filter(Boolean)
      .some((path) => SECRET_PATH.test(path) || SECRET_PATH_FRAGMENT.test(path));
  } catch {
    return false;
  }
}

/**
 * Best-effort: is a secret path currently STAGED (in the index) in the repo at
 * `cwd`? Used to decide `git commit`. Returns true (deny) if so; false on any
 * failure.
 */
function repoHasStagedSecret(cwd) {
  try {
    const res = spawnSync("git", ["-C", cwd, "diff", "--cached", "--name-only"], {
      encoding: "utf8",
      timeout: 4000,
    });
    if (res.status !== 0 || typeof res.stdout !== "string") return false;
    return res.stdout
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean)
      .some((path) => SECRET_PATH.test(path) || SECRET_PATH_FRAGMENT.test(path));
  } catch {
    return false;
  }
}

/**
 * Decide a git command segment against the secret boundary. Returns a reason
 * string to deny, "allow" to explicitly permit (the segment is a safe git op
 * on a secret path, e.g. `git status .env`), or null (not a decisive git op —
 * fall through to the generic checks).
 */
function gitSecretReason(segment, cwd) {
  const trimmed = segment.trim();
  if (!/^git\b/i.test(trimmed)) return null;
  const namesSecret = SECRET_PATH_FRAGMENT.test(trimmed);

  // Reading a secret's contents into context (diff/show/log -p/blame/grep).
  if (namesSecret && GIT_READ_SUBCMD.test(trimmed)) {
    return "git reads a secret file's contents into context";
  }
  // Staging an explicitly-named secret into the index.
  if (namesSecret && GIT_STAGE_SUBCMD.test(trimmed) && !GIT_ADD_ALL.test(trimmed)) {
    return "git stages a secret file into the index";
  }
  // `git add .` / `-A` — stateful: deny if the repo has an untracked/modified
  // secret. If git can't be inspected, fall back to denying these blanket-add
  // forms (we can't prove no secret would be swept in).
  if (GIT_ADD_ALL.test(trimmed)) {
    if (repoHasUnstagedOrModifiedSecret(cwd)) {
      return "git add . / -A would stage an untracked or modified secret file";
    }
    // Can't confirm the repo is clean of secrets → fall back to deny unless we
    // positively observed no secret. repoHasUnstagedOrModifiedSecret returns
    // false both when clean AND when git failed; distinguish by re-probing.
    if (!gitInspectionAvailable(cwd)) {
      return "git add . / -A cannot be proven secret-free (git inspection unavailable)";
    }
    return "allow";
  }
  // `git commit` — stateful: deny if a secret is already staged.
  if (GIT_COMMIT.test(trimmed)) {
    if (repoHasStagedSecret(cwd)) {
      return "git commit would commit a secret file that is currently staged";
    }
    return "allow";
  }
  // Other git ops naming a secret that only touch metadata (status, rm,
  // rm --cached, ls-files) are safe.
  if (namesSecret) return "allow";
  return null;
}

/** Is `cwd` a git repo we can actually inspect? Used to decide the `git add .`
 * fallback (deny when we cannot prove the repo is secret-free). */
function gitInspectionAvailable(cwd) {
  try {
    const res = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      timeout: 4000,
    });
    return res.status === 0 && String(res.stdout).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * A bare `git status <secret>`, `git rm <secret>`, or `rm <secret>` names a
 * secret path, but the path is governed by other rules (DENY_COMMANDS /
 * repo-write checks / gitSecretReason above), not a contents-leaving read.
 * Only treat a segment as "safely governed" when its ENTIRE command is such an
 * op with no read/redirect/source/pipe/substitution attached — otherwise a
 * benign-looking segment could sit next to a real read and we'd deny the whole
 * command anyway. NOTE: `git add`/`git diff`/`git show`/`git log` are
 * deliberately NOT benign here — they are routed through gitSecretReason.
 */
function isSafelyGovernedSecretMention(cmd) {
  const trimmed = cmd.trim();
  // Whole command is exactly a git-status / git-rm / rm / ls of paths, with no
  // contents-leaving construct anywhere. (git add/diff/show/log excluded.)
  const benignOp = /^(git\s+(rm|status|ls-files)|rm|ls|stat|file|chmod|chown|touch)\b/i.test(
    trimmed,
  );
  if (!benignOp) return false;
  if (REDIRECT_READ.test(trimmed)) return false;
  if (SOURCE_SECRET.test(trimmed)) return false;
  if (COMMAND_SUBSTITUTION.test(trimmed)) return false;
  if (PIPE_OR_XARGS.test(trimmed)) return false;
  if (SECRET_ASSIGNMENT.test(trimmed)) return false;
  return true;
}

/**
 * Decide whether a whole Bash command crosses the contents-leaving /
 * path-reference boundary. Returns a reason string to block on, or null.
 *
 * This is the new core. It is deliberately path-centric and biased to DENY:
 * the moment a secret-path fragment, secret glob, redirect/source of a
 * secret, or a data-flow-hiding construct combined with a secret appears, we
 * stop. We also conservatively deny command-substitution + a read-ish tool
 * even without a visible secret, because a base64/echo-decoded path cannot be
 * regex-caught.
 */
function secretBoundaryReason(cmd, cwd = process.cwd()) {
  // (0) Git secret-op boundary — runs first because git ops that read/stage a
  // secret look benign to the generic checks. Inspect every segment: a git
  // read/stage of a secret denies the whole command; a safe git op on a secret
  // (status/rm) is recorded so the generic path below doesn't re-flag it.
  {
    const segments = cmd.split(/(?:&&|\|\||[;&|\n])/);
    let anyGitAllowed = false;
    for (const segment of segments) {
      const reason = gitSecretReason(segment, cwd);
      if (reason === null) continue;
      if (reason !== "allow") return reason; // git read/stage of a secret → deny
      anyGitAllowed = true; // a safe git op on a secret (status/rm/commit-clean)
    }
    // If a git op explicitly cleared a secret mention (e.g. `git status .env`)
    // and there is no OTHER non-git secret mention, let it through — the generic
    // path below would otherwise re-flag the same secret token.
    if (anyGitAllowed) {
      const nonGitSecret = segments.some(
        (s) => SECRET_PATH_FRAGMENT.test(s) && !/^\s*git\b/i.test(s.trim()),
      );
      if (!nonGitSecret) return null;
    }
  }

  // (5) Command substitution that hides the path entirely, combined with a
  // read-ish/exfil tool. We can't see the decoded path, so over-block.
  // e.g. `cat "$(echo LmVudg== | base64 -d)"`.
  if (COMMAND_SUBSTITUTION.test(cmd) && READISH_TOOL.test(cmd)) {
    return "command substitution feeding a read/exfil tool (path is hidden from static analysis — over-blocking by policy)";
  }

  // (2) Input redirection from a secret path: `< .env`, `read -r X < .env`.
  if (REDIRECT_READ.test(cmd)) return "input redirection from a secret file";
  // (2) `source .env` / `. .env` loads secrets into the environment.
  if (SOURCE_SECRET.test(cmd)) return "sourcing a secret file into the environment";

  // (3) Glob/wildcard whose literal part overlaps a secret family.
  if (SECRET_GLOB.test(cmd)) return "glob/wildcard matching a secret-file family";

  const namesSecret = SECRET_PATH_FRAGMENT.test(cmd);

  // (4) Pipe / xargs / command-substitution that decouples tool from path,
  // with a secret named upstream: `echo .env | xargs cat`.
  if (namesSecret && (PIPE_OR_XARGS.test(cmd) || COMMAND_SUBSTITUTION.test(cmd))) {
    return "secret path piped/xargs'd/substituted into another command";
  }

  // (1) A secret-path fragment appears anywhere. Split on separators and
  // allow ONLY if EVERY segment that mentions a secret is a safely-governed
  // op (git add/rm of that file). Any other mention → deny.
  if (namesSecret) {
    const segments = cmd.split(/(?:&&|\|\||[;&|\n])/);
    for (const segment of segments) {
      if (SECRET_PATH_FRAGMENT.test(segment) && !isSafelyGovernedSecretMention(segment)) {
        return "a secret path appears in a read/reference position";
      }
    }
  }

  // Variable indirection: `f=.env; cat "$f"`. The assignment names the
  // secret; the later `$f` read is invisible. Deny when the assignment is
  // not the whole, safely-governed command.
  if (SECRET_ASSIGNMENT.test(cmd) && !isSafelyGovernedSecretMention(cmd)) {
    return "secret path assigned to a variable (later dereference hides the read)";
  }

  // Inline interpreter reading a file via primitive on a named secret. We
  // require the command to actually NAME a secret path (namesSecret): a bare
  // read primitive on a NON-secret literal (e.g. `node -e
  // "fs.readFileSync('x.ts')"`) is a legitimate in-bounds op and is governed by
  // the root-based inline-read boundary in checkCommand, not denied here. The
  // FILE_READ_PRIMITIVE signal is still used, but only as corroboration that a
  // secret-naming command is in fact reading that secret's contents.
  if (INLINE_INTERPRETER.test(cmd) && namesSecret && FILE_READ_PRIMITIVE.test(cmd)) {
    return "inline interpreter reading a secret file";
  }

  return null;
}

// =====================================================================
// BASH WRITE-OP / BRANCH-CREATION TARGET EXTRACTION (FG-007)
// ---------------------------------------------------------------------
// The file-tool path checks (checkWrite) cover Write/Edit/MultiEdit, but a
// Bash command can mutate the filesystem too. We extract the TARGET paths of
// the mutating bash constructs and run each through the write-root boundary,
// and extract branch-creation targets to enforce "branch only in a write
// root". This is deliberately conservative: a target we cannot resolve to a
// clearly in-root path is treated as a boundary candidate (deny), never
// silently allowed. We do NOT try to perfectly parse shell — we look for the
// well-known mutating forms and their destination operand.
// =====================================================================

/** Strip surrounding quotes from a shell token. */
function unquote(token) {
  return token.replace(/^['"]|['"]$/g, "");
}

// =====================================================================
// EFFECTIVE-VERB RESOLUTION (P0 verb-bypass fix)
// ---------------------------------------------------------------------
// The verb-style extractors below used to take `tokens[0]` as THE verb. Any
// prefix that demotes the real verb (a `VAR=value` assignment, or a no-op
// wrapper like `env`, `command`, `nice`, `nohup`, `timeout 5`, …) made the
// real mutating/read verb sit at tokens[1+], so it was never recognised and the
// write/read-root boundary was skipped entirely. We now resolve the EFFECTIVE
// verb+operands by stripping those leading no-op prefixes before dispatch.
// =====================================================================

// Transparent wrapper commands that exec their argument program unchanged.
// After stripping the wrapper (and its own flags/args), the NEXT token is the
// real verb. `time`, `timeout`, `ionice`, `nice`, `stdbuf` may take their own
// option/argument tokens; we skip leading `-flags` and, conservatively, a
// single numeric/duration argument for the ones that take one.
const WRAPPER_COMMANDS = new Set([
  "env",
  "command",
  "nice",
  "nohup",
  "stdbuf",
  "setsid",
  "time",
  "timeout",
  "ionice",
  "doas",
]);

// `VAR=value` leading assignment (one or more, space-separated) — these set
// environment for the command that follows and are NOT the verb.
const ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Given the raw tokens of a single command segment, peel off leading
 * `VAR=value` assignments and known no-op wrapper commands (re-resolving the
 * verb after each) and return the EFFECTIVE `{ verb, operands }`. Operands are
 * the remaining tokens with their `-flags` removed (matching how the verb
 * dispatch below consumes them). Returns null when nothing remains.
 *
 * Biased to deny on ambiguity: when an `xargs` is the effective wrapper, the
 * real verb is fed its target from STDIN, so the caller treats it specially
 * (see EFFECTIVE_VERB_UNVERIFIABLE).
 */
function resolveEffectiveTokens(tokens) {
  let i = 0;
  // Loop: strip assignments and wrappers until we hit a real verb.
  for (;;) {
    // (a) Leading `VAR=value` assignments.
    while (i < tokens.length && ASSIGNMENT_TOKEN.test(tokens[i])) i += 1;
    if (i >= tokens.length) return null;
    const word = tokens[i];
    if (!WRAPPER_COMMANDS.has(word)) break;
    // (b) Skip the wrapper word itself…
    i += 1;
    // …then its own leading `-flags` and any further `VAR=` (env supports both:
    // `env -i`, `env -u X`, `env VAR=1 cmd`).
    while (i < tokens.length && (tokens[i].startsWith("-") || ASSIGNMENT_TOKEN.test(tokens[i]))) {
      i += 1;
    }
    // For wrappers that take a single leading numeric/duration argument
    // (`timeout 5 cmd`, `nice 10 cmd`, `ionice 3 cmd`), skip one such token.
    if (
      (word === "timeout" || word === "nice" || word === "ionice") &&
      i < tokens.length &&
      /^[0-9]/.test(tokens[i])
    ) {
      i += 1;
    }
    // Continue the loop to re-resolve (handles `env VAR=1 command nice cmd`).
  }
  const verb = tokens[i];
  const operands = tokens.slice(i + 1).filter((t) => !t.startsWith("-"));
  return { verb, operands, rest: tokens.slice(i) };
}

/**
 * Resolve the effective verb of a token list that may begin with leading
 * `-flags` (e.g. the tokens after `xargs`). Skips `-flags`, then strips
 * assignments/wrappers via resolveEffectiveTokens. Returns the verb string, or
 * "" when none resolves. Biased to deny: an empty/ambiguous result lets the
 * caller treat it as unverifiable.
 */
function effectiveVerbAfter(tokens) {
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith("-")) i += 1;
  const eff = resolveEffectiveTokens(tokens.slice(i));
  return eff ? eff.verb : "";
}

// Sentinel write/read target representing an UNVERIFIABLE path — one the hook
// cannot resolve from the segment (e.g. an `xargs <verb>` target that comes
// from STDIN). It is guaranteed to be outside every root, so classifying it
// always yields "outside" and the boundary fails CLOSED.
const UNVERIFIABLE_TARGET = " unverifiable ";

// Mutating verbs whose target, when fed via `xargs`, comes from STDIN and so
// cannot be verified against the roots → must fail closed as a write.
const XARGS_WRITE_VERBS = new Set([
  "tee",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "rm",
  "dd",
  "truncate",
  "shred",
  "install",
  "ln",
  "rsync",
]);
// Read verbs whose target, when fed via `xargs`, comes from STDIN → fail closed
// as a read (only enforced when roots are configured, like other reads).
const XARGS_READ_VERBS = new Set([...READ_TOOL_VERBS]);

// Inline-shell wrappers (`sh -c '<prog>'`, `bash -lc "<prog>"`, …): the quoted
// body is a NESTED program that must be re-scanned by the same extractor.
const SHELL_DASH_C =
  /\b(?:sh|bash|zsh|dash)\b\s+(?:-[A-Za-z]*c[A-Za-z]*|--command)\s+("[^"]*"|'[^']*')/g;

/** Pull every `sh -c '<body>'` / `bash -lc "<body>"` nested program body. */
function extractShellDashCBodies(cmd) {
  const bodies = [];
  for (const m of cmd.matchAll(SHELL_DASH_C)) {
    const body = unquote(m[1]);
    if (body) bodies.push(body);
  }
  return bodies;
}

// awk-family interpreters: the program body can redirect output to a file with
// `> "path"` / `>> path`, which is a WRITE outside the file-tool checks.
const AWK_FAMILY = new Set(["awk", "gawk", "mawk", "nawk"]);

/**
 * Extract redirect WRITE targets from an awk program body. A file-write redirect
 * in awk is an OUTPUT statement (`print`/`printf`) followed by `>`/`>>` and the
 * destination, e.g. `print 1 > "/path"` or `printf "%s",x >> dst`. We anchor on
 * the `print`/`printf` so a bare relational comparison (`$1 > 5`) is NOT treated
 * as a redirect. The destination may be a quoted/bare literal path OR a dynamic
 * expression (a variable / concatenation); a present-but-unresolvable redirect
 * is surfaced as UNVERIFIABLE so it fails closed.
 */
function extractAwkRedirectTargets(awkBody) {
  const targets = [];
  let sawRedirect = false;
  let sawLiteral = false;
  // `print`/`printf … >|>> <dest>` — capture the destination token after the op.
  for (const m of awkBody.matchAll(
    /\b(?:print|printf)\b[^>\n]*?>>?\s*("[^"]*"|'[^']*'|[^\s;{}&|)]+)/g,
  )) {
    sawRedirect = true;
    const rawToken = m[1];
    const raw = unquote(rawToken);
    const quoted = rawToken.startsWith('"') || rawToken.startsWith("'");
    // A quoted literal, or a bare path-shaped token, is a resolvable destination.
    if (quoted || raw.includes("/") || raw.includes(".") || raw.startsWith("~")) {
      sawLiteral = true;
      targets.push(canonicalize(resolve(process.cwd(), raw)));
    }
    // Otherwise the destination is a bare identifier (a variable) → dynamic.
  }
  // A redirect we detected but could not pin to a literal → fail closed.
  if (sawRedirect && !sawLiteral) targets.push(UNVERIFIABLE_TARGET);
  return targets;
}

/**
 * Extract candidate WRITE target paths from a bash command. Covers:
 *   • output redirection `> f` / `>> f`            (and `n> f`, `&> f`)
 *   • `tee f` / `tee -a f`
 *   • `cp src dst` / `mv src dst`                  (destination = last operand)
 *   • `mkdir [-p] d...`  • `touch f...`  • `rm [...] f...`
 *   • `sed -i ... f`                               • `dd of=f`
 * Returns absolute, canonicalised paths. Best-effort: a path we can't parse is
 * simply not returned (the generic secret/dangerous rules still apply), but a
 * path we DO parse is enforced against the write-roots.
 */
function extractBashWriteTargets(cmd) {
  const targets = [];
  const add = (raw) => {
    if (!raw) return;
    const p = unquote(raw.trim());
    if (!p || p.startsWith("-")) return;
    // A destination carrying shell interpolation (`$HOME/x`, `${OUT}/f`,
    // `` `pwd`/x ``) is NOT a provable literal — resolving it would treat the
    // `$VAR` as a relative dir and silently pin the write INSIDE the write-root,
    // escaping the worktree. Fail CLOSED via the sentinel (classified "outside"
    // → BLOCK), mirroring the inline-interpreter write path and the bash-READ
    // path. This precedes the /dev and fd screens because those only match bare
    // tokens, never an interpolated one.
    if (/[$`]|\$\{/.test(p)) {
      targets.push(UNVERIFIABLE_TARGET);
      return;
    }
    // Skip process substitutions / fds / globs we can't resolve to a real path.
    if (/^[&\d]+$/.test(p) || p.startsWith("/dev/")) return;
    targets.push(canonicalize(resolve(process.cwd(), p)));
  };

  // Output redirection: `> file`, `>> file`, `2> file`, `&> file`.
  for (const m of cmd.matchAll(/(?:^|\s)(?:[0-9]*|&)>>?\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)) {
    add(m[1]);
  }
  // `dd of=FILE`.
  for (const m of cmd.matchAll(/\bof=("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)) add(m[1]);

  // Per-segment parsing for the verb-style mutators.
  for (const segment of cmd.split(/(?:&&|\|\||[;&|\n])/)) {
    const tokens = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    if (tokens.length === 0) continue;
    // Resolve the EFFECTIVE verb: strip leading `VAR=value` assignments and no-op
    // wrapper commands so a demoted verb (`env tee …`, `VAR=1 mv …`) is still seen.
    const effective = resolveEffectiveTokens(tokens);
    if (!effective) continue;
    const { verb, operands } = effective;

    // `xargs <verb>`: the real verb's target comes from STDIN — unverifiable from
    // this segment. If that inner verb is a mutating one, FAIL CLOSED. The inner
    // verb is the first non-flag token after `xargs` (xargs' own flags skipped).
    if (verb === "xargs") {
      const innerVerb = effectiveVerbAfter(effective.rest.slice(1));
      if (XARGS_WRITE_VERBS.has(innerVerb)) {
        targets.push(UNVERIFIABLE_TARGET); // STDIN-fed mutating target → deny
      }
      continue;
    }

    if (verb === "tee") {
      // `tee f` / `tee -a f g` — every non-flag operand is a write target.
      for (const op of operands) add(op);
    } else if (verb === "cp" || verb === "mv" || verb === "install" || verb === "ln") {
      // Destination is the LAST operand.
      if (operands.length >= 1) add(operands[operands.length - 1]);
    } else if (verb === "mkdir" || verb === "touch" || verb === "rm" || verb === "truncate") {
      // `truncate -s 0 FILE` — operands already have `-flags` stripped, but
      // `truncate`'s `-s` takes a value (`0`, `10K`). Drop a leading size arg.
      const ops =
        verb === "truncate" ? operands.filter((o) => !/^[0-9]+[KMGkmg]?$/.test(o)) : operands;
      for (const op of ops) add(op);
    } else if (verb === "sed" && /\s-[a-z]*i/.test(segment)) {
      // `sed -i ... FILE` — in-place edit; the file is the last operand.
      if (operands.length >= 1) add(operands[operands.length - 1]);
    } else if (AWK_FAMILY.has(verb)) {
      // awk/gawk/mawk: scan the program body for `> path` redirect write targets.
      // The program is the first non-flag operand (the quoted script).
      for (const op of operands) {
        for (const t of extractAwkRedirectTargets(unquote(op))) targets.push(t);
      }
    }
  }

  // RECURSE into `sh -c '<body>'` / `bash -lc "<body>"` nested programs: the
  // quoted body is a full program that can carry its own write ops.
  for (const body of extractShellDashCBodies(cmd)) {
    for (const t of extractBashWriteTargets(body)) targets.push(t);
  }
  return targets;
}

/**
 * Extract candidate READ target paths from a bash command's read tools
 * (cat/sed/grep/awk/head/tail/less/more/od/xxd/nl/strings + friends). Returns
 * absolute, canonicalised paths for the LITERAL operands only. Used for the P1
 * read boundary: a literal target confirmed OUTSIDE all roots is blocked.
 *
 * Conservative on purpose: we only return operands that look like real path
 * literals (no globs, no `$`/`` ` `` interpolation, no flags, no fd/dev nodes).
 * Dynamic reads are intentionally NOT surfaced here — the secret-path guard
 * already covers the high-value case and fail-closing reads would be too
 * aggressive (the honest residual: a runtime-built read path can still slip).
 */
function extractBashReadTargets(cmd) {
  const targets = [];
  for (const segment of cmd.split(/(?:&&|\|\||[;&|\n])/)) {
    const tokens = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    if (tokens.length === 0) continue;
    // Resolve the EFFECTIVE verb so a demoted reader (`command cat …`,
    // `env X=1 cat …`) is still recognised against READ_TOOL_VERBS.
    const effective = resolveEffectiveTokens(tokens);
    if (!effective) continue;
    const { verb, operands } = effective;

    // `xargs <read-verb>`: target comes from STDIN — unverifiable → fail closed.
    if (verb === "xargs") {
      const innerVerb = effectiveVerbAfter(effective.rest.slice(1));
      if (XARGS_READ_VERBS.has(innerVerb)) targets.push(UNVERIFIABLE_TARGET);
      continue;
    }

    if (!READ_TOOL_VERBS.has(verb)) continue;
    for (const tok of operands) {
      const raw = unquote(tok.trim());
      if (!raw) continue;
      // Skip non-path-literals: globs, interpolation, fds, /dev, sed scripts
      // like `1,5p` / `s/a/b/`, and bare option-ish tokens.
      if (/[*?$`]|\$\{/.test(raw)) continue;
      if (raw.startsWith("/dev/") || /^[&\d]+$/.test(raw)) continue;
      if (!raw.includes("/") && !raw.includes(".")) continue; // not path-shaped
      targets.push(canonicalize(resolve(process.cwd(), raw)));
    }
  }

  // RECURSE into `sh -c '<body>'` nested programs for read tools too.
  for (const body of extractShellDashCBodies(cmd)) {
    for (const t of extractBashReadTargets(body)) targets.push(t);
  }
  return targets;
}

// Branch-creation forms that must only occur inside a write-root:
//   `git checkout -B <branch>`  `git branch <branch>`  `git switch -c <branch>`
const BRANCH_CREATE =
  /\bgit\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?(?:checkout\s+-B\b|switch\s+-c\b|switch\s+--create\b|branch\b(?!\s+(?:-[dD]|--delete|--list|-a|-r|-v|--show-current)))/;

/**
 * Enforce branch creation only inside a write-root. The relevant location is
 * the repo the branch is created in: `git -C <dir> …` names it explicitly,
 * otherwise it is the cwd. Returns a block reason or null.
 */
function branchCreationBoundaryReason(cmd, roots) {
  const m = cmd.match(BRANCH_CREATE);
  if (!m) return null;
  const dir = m[1] ? unquote(m[1]) : ".";
  const abs = canonicalize(resolve(process.cwd(), dir));
  if (classifyRootAccess(abs, roots) !== "write") {
    return `branch creation outside write-roots (target repo is not writable): ${dir} [write-roots: ${roots.writeRoots.join(", ")}]`;
  }
  return null;
}

function checkCommand(cmd) {
  // A bootstrap tick (GAFFER_BOOTSTRAP_INSTALL=1) may relax ONLY the install-tagged
  // DENY rule, and ONLY for an install inside the fresh bootstrap dir. Compute it
  // once; every other rule (and the install rule itself, when not a scoped
  // bootstrap install) stays in force.
  const allowInstall = bootstrapInstallAllowed(cmd);
  for (const rule of DENY_COMMANDS) {
    if (rule.install && allowInstall) {
      // The bootstrap allowance would permit this install — but ONLY if it cannot
      // run dependency lifecycle scripts (postinstall ACE). Require the explicit
      // --ignore-scripts flag; without it the install stays BLOCKED even on a
      // bootstrap tick (the agent must pass the flag).
      if (rule.install && rule.re.test(cmd) && !installHasIgnoreScripts(cmd)) {
        block(
          `permitted install must pass --ignore-scripts (dependency lifecycle scripts are arbitrary code execution) — "${cmd.slice(0, 120)}"`,
        );
      }
      continue; // scoped bootstrap install WITH --ignore-scripts — permitted
    }
    if (rule.re.test(cmd)) block(`${rule.why} — "${cmd.slice(0, 120)}"`);
  }
  const reason = secretBoundaryReason(cmd, process.cwd());
  if (reason) block(`${reason} — "${cmd.slice(0, 120)}"`);

  // Repo-access boundary for bash write ops and branch creation.
  const roots = resolveRoots();
  for (const target of extractBashWriteTargets(cmd)) {
    const access = classifyRootAccess(target, roots);
    if (access !== "write") {
      block(
        `write outside write-roots (bash write op targets ${access === "read" ? "a read-only root" : "outside all roots"}): ${target} — "${cmd.slice(0, 120)}"`,
      );
    }
  }

  // Inline-interpreter WRITE boundary (P0). Enforced whenever roots are
  // CONFIGURED — under the single-repo fallback this still applies (the cwd is
  // the write-root), which is never MORE permissive than today. Fail-closed on
  // dynamic destinations (see inlineWriteBoundaryReason).
  const inlineWrite = inlineWriteBoundaryReason(cmd, roots);
  if (inlineWrite) block(`${inlineWrite} — "${cmd.slice(0, 120)}"`);

  // Read boundary (P1) — only when roots are explicitly configured (the
  // fallback never restricted reads, and we must not become more restrictive).
  // The secret-path guard above already ran and takes precedence.
  if (roots.configured) {
    const inlineRead = inlineReadBoundaryReason(cmd, roots);
    if (inlineRead) block(`${inlineRead} — "${cmd.slice(0, 120)}"`);
    for (const target of extractBashReadTargets(cmd)) {
      if (classifyRootAccess(target, roots) === "outside") {
        block(
          `read outside allowed roots (bash read tool targets outside all roots): ${target} — "${cmd.slice(0, 120)}"`,
        );
      }
    }
  }

  const branchReason = branchCreationBoundaryReason(cmd, roots);
  if (branchReason) block(`${branchReason} — "${cmd.slice(0, 120)}"`);

  allow();
}

function checkWrite(filePath) {
  if (!filePath) allow();
  const roots = resolveRoots();
  const abs = canonicalize(resolve(process.cwd(), filePath));
  if (SECRET_PATH.test(abs)) block(`write to a secret file: ${filePath}`);
  if (GIT_INTERNAL.test(abs)) block(`write inside .git: ${filePath}`);
  // Repo-access boundary: a write is allowed ONLY inside a write-root. A target
  // in a read-only root, or outside all roots, is denied.
  const access = classifyRootAccess(abs, roots);
  if (access !== "write") {
    block(
      `write outside write-roots (target is ${access === "read" ? "in a read-only root" : "outside all roots"}): ${filePath} [write-roots: ${roots.writeRoots.join(", ")}]`,
    );
  }
  allow();
}

function checkRead(filePath) {
  if (!filePath) allow();
  const abs = canonicalize(resolve(process.cwd(), filePath));
  // Existing secret-file denial takes precedence and is never weakened.
  if (SECRET_PATH.test(abs)) {
    block(`read of a secret file (keeps secrets out of model context): ${filePath}`);
  }
  // Repo-access boundary: reads are allowed inside (write-roots ∪ read-roots).
  // A read fully outside all roots is denied — but ONLY when roots are
  // explicitly configured. Under the single-repo fallback, reads stay
  // unrestricted (preserving today's behaviour, never more restrictive).
  const roots = resolveRoots();
  if (roots.configured && classifyRootAccess(abs, roots) === "outside") {
    block(
      `read outside allowed roots: ${filePath} [write-roots: ${roots.writeRoots.join(", ")}; read-roots: ${roots.readRoots.join(", ")}]`,
    );
  }
  allow();
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // If we can't parse the hook payload, fail safe-open for non-mutating tools
    // but the matchers below only route mutating tools here, so allow.
    allow();
  }
  const tool = payload.tool_name ?? payload.toolName ?? "";
  const input = payload.tool_input ?? payload.toolInput ?? {};
  CURRENT_TOOL = tool;
  CURRENT_TARGET =
    input.command ?? input.file_path ?? input.filePath ?? input.notebook_path ?? null;
  switch (tool) {
    case "Bash":
      return checkCommand(String(input.command ?? ""));
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return checkWrite(String(input.file_path ?? input.filePath ?? input.notebook_path ?? ""));
    case "Read":
      return checkRead(String(input.file_path ?? input.filePath ?? ""));
    default:
      return allow();
  }
});
