/**
 * Reads and credentials: the contents-leaving / path-reference boundary for secret paths,
 * git's secret operations, tracked env templates, search-pattern masking, and the read
 * targets of a Bash command.
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  CLI_CREDENTIAL_FRAGMENT,
  CRED_NAME_FRAGMENT,
  ENV_FILE_FRAGMENT,
  ENV_TEMPLATE,
  MCP_RUNTIME_FILE,
  PROC_ENVIRON,
  SECRET_PATH,
  TOKEN_SOURCE_EXT_GUARD,
  canonicalize,
  expandTildeWord,
  replayCd,
} from "./paths.mjs";
import { UNVERIFIABLE_TARGET, normalizeVerb, tokenizeSegment } from "./shell.mjs";
import { effectiveVerbAfter, extractShellDashCBodies, resolveEffectiveTokens } from "./verbs.mjs";

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
// The `dashboard-token`/`*-token` fragments require a `[._-]` separator directly
// before `token` (or match the literal `dashboard-token`), so an unrelated bare
// word like `TOKEN` used as a grep pattern is NOT flagged — only real token-file
// references (`.gaffer/dashboard-token`, `api.token`, `foo_token`) are. The
// token family carries TOKEN_SOURCE_EXT_GUARD so a token-named SOURCE file
// (`src/design-tokens.json`, `csrf_token.ts`) in an ordinary command position
// (`npx prettier --write src/design-tokens.json`) is not flagged; the exact
// `dashboard-token` alternative is guard-free and always fires.
const SECRET_PATH_FRAGMENT = new RegExp(
  String.raw`(${ENV_FILE_FRAGMENT}|[\w./-]*\.pem\b|[\w./-]*\.key\b|[\w./-]*\.p12\b|id_rsa\b|id_ed25519\b|id_[a-z0-9]+\b|\.ssh\/|\.aws\/|\.npmrc\b|\.git-credentials\b|\.netrc\b|\.gnupg\/|${CLI_CREDENTIAL_FRAGMENT}|${CRED_NAME_FRAGMENT}|${MCP_RUNTIME_FILE}\b|${PROC_ENVIRON}\b|dashboard-token\b|[\w./-]*[._-]tokens?${TOKEN_SOURCE_EXT_GUARD}\b)`,
  "i",
);

// Glob/wildcard tokens whose literal part overlaps a secret family. These
// resolve to secret paths at runtime even though no full secret name is
// written literally (`.en*`, `.e?v`, `.en[v]`, `id_*`, `*.pem`, `*.key`,
// `*credential*`, `*secret*`). We match the wildcard form specifically so
// an ordinary glob like `*.ts` or `src/*` is not flagged.
const SECRET_GLOB =
  /(\.e[*?]|\.en[*?]|\.env[*?]|[*?][\w.-]*\.env\b|\.e\[|\.en\[|id_[*?]|id_\[|[*?][\w.]*\.pem\b|[*?][\w.]*\.key\b|[*?][\w.]*\.p12\b|[*?][\w./-]*credential|[*?][\w./-]*secret|credential[\w./-]*[*?]|secret[\w./-]*[*?]|[*?][\w./-]*token|token[\w./-]*[*?]|dashboard-token[*?]|mcp-runtime[\w.-]*[*?])/i;

// Shell read/redirect/source positions that consume a file's CONTENTS
// without naming a "reader" binary:
//   `< .env`        input redirection
//   `source .env` / `. .env`   load secrets into the environment
//   `read ... < .env` / `mapfile < .env`  (the `<` rule catches these too)
const REDIRECT_READ =
  /<\s*["']?[\w./~$-]*(\.env|\.pem|\.key|\.p12|id_rsa|id_ed25519|\.ssh\/|\.aws\/|\.npmrc|\.git-credentials|\.netrc|\.config\/gh\/|\.config\/gcloud\/|\.docker\/config\.json|\.kube\/|\.azure\/|\.pypirc|\.pgpass|\.claude\.json|credentials|secrets?|mcp-runtime(?:\.\w+)*\.json|proc\/[^\s'"]*\/environ|dashboard-token|[._-]tokens?)/i;
const SOURCE_SECRET =
  /(^|[\n;&|])\s*(source|\.)\s+["']?[\w./~$-]*(\.env|\.pem|\.key|\.p12|id_rsa|id_ed25519|\.ssh\/|\.aws\/|\.npmrc|\.git-credentials|\.netrc|\.config\/gh\/|\.config\/gcloud\/|\.docker\/config\.json|\.kube\/|\.azure\/|\.pypirc|\.pgpass|\.claude\.json|credentials|secrets?|mcp-runtime(?:\.\w+)*\.json|proc\/[^\s'"]*\/environ|dashboard-token|[._-]tokens?)/i;

// Command-substitution / pipe / xargs constructs that decouple the tool
// from the path it operates on, hiding the data flow from static analysis.
const COMMAND_SUBSTITUTION = /\$\([^)]*\)|`[^`]*`/;
const PIPE_OR_XARGS = /\||\bxargs\b/;

// Read-ish tools — used ONLY for the conservative command-substitution
// over-block (rule 5). This is no longer the primary gate; it is a
// belt-and-braces signal for "this segment moves file contents". Kept
// broad on purpose (a denylist here only ADDS denials, never removes the
// path-fragment denial that does the real work).
// `ps` is included here (S-H1): it can print another process's environment
// (`$(ps ewww)`), so it counts as a contents-moving/exfil tool for the
// command-substitution over-block below. A bare `ps` command is separately
// hard-blocked by the canonical dangerous-command deny list.
const READISH_TOOL =
  /\b(cat|head|tail|less|more|bat|sed|awk|nl|tac|cut|sort|uniq|column|fmt|paste|join|comm|expand|unexpand|fold|pr|rev|grep|egrep|fgrep|rg|ag|ack|strings|xxd|od|hexdump|base64|base32|xxencode|uuencode|openssl|ssh-keygen|gpg|ps|cp|mv|scp|rsync|sftp|tar|cpio|dd|tee|curl|wget|nc|ncat|socat|mail|mailx|sendmail)\b/i;

// Interpreters that can read a file via an inline program (-c / -e / -ne / -pe …).
const INLINE_INTERPRETER =
  /\b(python3?|perl|ruby|node|deno|bun|php|bash|sh|zsh)\b[^\n]*\s-(c|e|ne|pe|Ee?)\b/i;
const FILE_READ_PRIMITIVE =
  /(readFileSync|readFile|read_text|File\.read|open\s*\(|fopen\s*\(|IO\.read|Get-Content)/i;

// Variable indirection: `f=.env` (or `f=~/.ssh/id_rsa`) assigns a secret
// path to a variable, which a later command then dereferences via `$f`.
// We can't follow the dataflow, so any secret-path assignment is treated
// as a read boundary unless the whole command is a single safe governed op.
// The token family carries TOKEN_SOURCE_EXT_GUARD (path-position rule): a
// build-style `FILE=src/design-tokens.json …` assignment of a token-named
// SOURCE file is legitimate; `f=.gaffer/dashboard-token` and extensionless
// token files stay denied.
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b[\w]+=["']?[\w./~$-]*(${ENV_FILE_FRAGMENT}|\.pem\b|\.key\b|\.p12\b|id_rsa\b|id_ed25519\b|\.ssh\/|\.aws\/|\.npmrc\b|\.git-credentials\b|\.netrc\b|${CLI_CREDENTIAL_FRAGMENT}|${CRED_NAME_FRAGMENT}|${MCP_RUNTIME_FILE}\b|${PROC_ENVIRON}\b|dashboard-token\b|[._-]tokens?${TOKEN_SOURCE_EXT_GUARD}\b)`,
  "i",
);

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

// Read verbs whose FIRST operand is a pattern or program, not a file.
const PATTERN_FIRST_VERBS = new Set(["sed", "grep", "egrep", "fgrep", "rg", "awk"]);
// Verbs that copy or encode their file operands (a credential copied into the
// worktree, or archived to stdout, leaves as surely as one that is `cat`-ed).
const COPY_READ_VERBS = new Set([
  "cp",
  "mv",
  "ln",
  "install",
  "rsync",
  "scp",
  "tar",
  "zip",
  "base64",
  "base32",
  "sort",
  "uniq",
  "diff",
  "cmp",
]);

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
    return (
      res.stdout
        .split("\n")
        .filter(Boolean)
        // A MODIFIED tracked env template (status not `??`) is ordinary content; an
        // untracked one could be a renamed real `.env` and still counts.
        .filter((line) => !(ENV_TEMPLATE.test(line.slice(3).trim()) && !line.startsWith("??")))
        .map((line) => line.slice(3).trim()) // strip the 2-char status + space
        .filter(Boolean)
        .some((path) => SECRET_PATH.test(path) || SECRET_PATH_FRAGMENT.test(path))
    );
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
    return (
      res.stdout
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean)
        // A staged env template got into the index through the gated `git add`.
        .filter((path) => !ENV_TEMPLATE.test(path))
        .some((path) => SECRET_PATH.test(path) || SECRET_PATH_FRAGMENT.test(path))
    );
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
  // Whole command is exactly a git-status / git-rm / rm / ls / stat of paths, with no
  // contents-leaving construct anywhere. (git add/diff/show/log excluded.) `touch`,
  // `chmod`, and `chown` are deliberately NOT benign: they mutate a secret path
  // (create it, or change its mode/owner) — side effects, not metadata-neutral reads —
  // so a segment naming a secret with those verbs must fall through to the strict path.
  const benignOp = /^(git\s+(rm|status|ls-files)|rm|ls|stat|file)\b/i.test(trimmed);
  if (!benignOp) return false;
  if (REDIRECT_READ.test(trimmed)) return false;
  if (SOURCE_SECRET.test(trimmed)) return false;
  if (COMMAND_SUBSTITUTION.test(trimmed)) return false;
  if (PIPE_OR_XARGS.test(trimmed)) return false;
  if (SECRET_ASSIGNMENT.test(trimmed)) return false;
  return true;
}

/**
 * Is `abs` a TRACKED, non-symlink env template (`.env.example` & co.) in its git
 * repo? Only then is it treated as an ordinary file. `abs` is canonicalised by the
 * callers, so a template that is a symlink to `.env` resolves to `.env` and never
 * reaches here as a template.
 */
function isTrackedEnvTemplate(abs) {
  if (!ENV_TEMPLATE.test(abs)) return false;
  try {
    if (lstatSync(abs).isSymbolicLink()) return false;
    const res = spawnSync(
      "git",
      ["-C", dirname(abs), "ls-files", "--error-unmatch", "--", basename(abs)],
      { encoding: "utf8", timeout: 4000 },
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Replace each TRACKED env-template path in a command with an inert placeholder
 * before the secret analysis, so `git diff .env.example`, `git add .env.example`
 * and `cat .env.example` of a committed template are not refused. Paths resolve
 * against the hook's cwd, so a command that changes directory is left unmasked
 * (fail closed: the path could name a different file there).
 */
function maskTrackedEnvTemplates(cmd) {
  if (/(?:^|[\s;&|(])(?:cd|pushd|popd)(?=$|\s)/.test(cmd)) return cmd;
  return cmd.replace(
    /(?<![\w$.-])((?:[\w.~/-]*\/)?\.env\.(?:example|sample|template|dist|defaults))(?![\w.-])/gi,
    (whole, path) => {
      const p = expandTildeWord(path, process.cwd());
      if (p === UNVERIFIABLE_TARGET) return whole;
      return isTrackedEnvTemplate(canonicalize(resolve(process.cwd(), p)))
        ? "__env_template__"
        : whole;
    },
  );
}

// Search tools whose FIRST positional operand (or every -e/--regexp value) is a
// content PATTERN, not a file. Flags whose next token is a value (not the pattern).
const SEARCH_VERBS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
const SEARCH_VALUE_FLAGS = new Set([
  "-A",
  "-B",
  "-C",
  "-m",
  "-g",
  "-t",
  "-T",
  "-M",
  "-j",
  "--glob",
  "--iglob",
  "--type",
  "--type-not",
  "--max-count",
  "--context",
  "--after-context",
  "--before-context",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--max-depth",
  "--threads",
  "--color",
  "--colour",
  "--sort",
  "--sortr",
]);
// The same value-taking flags as single letters, for a short-flag cluster (`-iA3`).
const SEARCH_SHORT_VALUE_LETTERS = new Set([..."ABCmgtTMjdD"]);

/**
 * The indexes in `args` (a search tool's arguments) of its content PATTERNS. GNU
 * grep and rg permute their arguments, so once ANY `-e`/`--regexp`/`-f`/`--file`
 * appears — anywhere, also inside a short-flag cluster (`-ve`, `-fX`) or as
 * `--file=` / `--regexp=` — every positional is a FILE and only the `-e` values are
 * patterns. Without one, the first positional (or the operand after `--`) is.
 */
function searchPatternIndexes(args) {
  let explicit = false;
  for (const raw of args) {
    const tk = normalizeVerb(raw);
    if (tk === "--") break;
    if (/^--(?:regexp|file)(?:=|$)/.test(tk) || /^-[A-Za-z0-9]*[ef]/.test(tk)) explicit = true;
  }
  const out = [];
  for (let k = 0; k < args.length; k += 1) {
    const tk = normalizeVerb(args[k]);
    if (tk === "--") {
      if (!explicit && k + 1 < args.length) out.push(k + 1);
      break;
    }
    if (tk === "-e" || tk === "--regexp") {
      if (k + 1 < args.length) out.push((k += 1));
    } else if (tk.startsWith("--regexp=")) {
      out.push(k);
    } else if (tk === "-f" || tk === "--file" || SEARCH_VALUE_FLAGS.has(tk)) {
      k += 1; // a value (for -f: a FILE — never masked)
    } else if (/^-[^-]/.test(tk)) {
      // Short cluster: the first value-taking letter takes the rest of the token,
      // or else the next token.
      for (let j = 1; j < tk.length; j += 1) {
        const c = tk[j];
        if (c !== "e" && c !== "f" && !SEARCH_SHORT_VALUE_LETTERS.has(c)) continue;
        const attached = j + 1 < tk.length;
        if (c === "e" && (attached || k + 1 < args.length)) out.push(attached ? k : k + 1);
        if (!attached) k += 1;
        break;
      }
    } else if (!tk.startsWith("-") && !explicit) {
      out.push(k);
      break;
    }
  }
  return out;
}

/** A search tool's non-flag operands other than its content patterns (its files). */
function searchFileOperands(args) {
  const patterns = new Set(searchPatternIndexes(args));
  return args.filter((tk, k) => !patterns.has(k) && !tk.startsWith("-"));
}

/** Does a raw shell word carry a `$` expansion outside single quotes? */
function hasShellExpansion(raw) {
  return /\$[\w{@*#?!$-]/.test(raw.replace(/'[^']*'/g, ""));
}

/**
 * May this pattern token be masked? Not when the shell could turn it into a file
 * name (`$VAR` / `${…}` outside single quotes, an unquoted glob), and not when it
 * names a path that EXISTS: masking that would hide a real read whenever the flag
 * parse above is wrong for the tool at hand (an optional-valued flag, an
 * ag/ack-only option, an `-e` in RIPGREP_CONFIG_PATH), so a misparse can only ever
 * mask a file that is not there. The cost: searching for the literal word `.env` in
 * a dir that holds a real `.env` is refused; `rg '\.env'` (regex-escaped) is not.
 */
function maskableSearchPattern(raw, cwd) {
  if (hasShellExpansion(raw)) return false;
  if (/[*?[]/.test(raw.replace(/'[^']*'|"[^"]*"/g, ""))) return false;
  const p = expandTildeWord(raw, cwd);
  if (p === UNVERIFIABLE_TARGET || p === "") return false;
  try {
    lstatSync(resolve(cwd, p));
    return false;
  } catch {
    return true;
  }
}

/**
 * Replace the content PATTERN of grep-family segments with a placeholder, so a
 * search for the WORD `credentials` / `.env` (`grep -rn credentials src/`) is not
 * mistaken for a read of a file of that name. A pattern is never opened as a file;
 * `-f`/`--file` values and every positional after an `-e`/`-f` ARE files and are
 * kept. Only whole tokens are replaced, in place, so separators, quotes and any
 * neighbouring text survive. Nothing is masked when the command has a command or
 * process substitution: the segment split would cut through it (`cat $(ls -a |
 * grep ^.en)`), and rule 5 must see the substitution intact.
 */
function stripSearchPatterns(cmd) {
  if (/\$\(|`|[<>]\(/.test(cmd)) return cmd;
  const parts = cmd.split(/(&&|\|\||[;&|\n])/);
  let cwd = canonicalize(process.cwd());
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    const tokens = tokenizeSegment(seg);
    const eff = tokens.length ? resolveEffectiveTokens(tokens) : null;
    if (!eff) continue;
    if (eff.verb === "cd" || eff.verb === "pushd" || eff.verb === "popd") {
      cwd = eff.verb === "popd" ? null : replayCd(eff, cwd);
      continue;
    }
    // After an unprovable cd, whether a token names an existing file is unknown.
    if (cwd === null) continue;
    let first = tokens.length - eff.rest.length + 1;
    if (eff.verb === "git") {
      if (tokens[first] !== "grep") continue;
      first += 1;
    } else if (!SEARCH_VERBS.has(basename(eff.verb))) continue;
    // An expansion anywhere in the arguments can become `-e` / `-f` at run time,
    // which turns the "pattern" into a file: mask nothing in this segment.
    if (tokens.slice(first).some(hasShellExpansion)) continue;
    const masked = searchPatternIndexes(tokens.slice(first))
      .map((k) => k + first)
      .filter((k) => maskableSearchPattern(tokens[k], cwd));
    if (masked.length === 0) continue;
    // Token offsets: tokenizeSegment keeps each token as a verbatim slice.
    const offsets = [];
    let at = 0;
    for (const tk of tokens) {
      at = seg.indexOf(tk, at);
      offsets.push(at);
      at += tk.length;
    }
    let out = seg;
    for (const k of masked.reverse()) {
      out =
        out.slice(0, offsets[k]) + "__search_pattern__" + out.slice(offsets[k] + tokens[k].length);
    }
    parts[i] = out;
  }
  return parts.join("");
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

// Read verbs whose target, when fed via `xargs`, comes from STDIN → fail closed
// as a read (only enforced when roots are configured, like other reads).
const XARGS_READ_VERBS = new Set([...READ_TOOL_VERBS]);

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
  // Effective cwd for relative reads, replayed from `cd`/`pushd` like the write
  // path — so `cd <outside> && cat rel` resolves `rel` OUTSIDE the roots and is
  // blocked. `null` marks a dynamic/unknown cd; unlike the write path, a relative
  // read under it is SKIPPED (not fail-closed) — reads are best-effort here (the
  // documented residual) and fail-closing them would be too aggressive.
  const startCwd = canonicalize(process.cwd());
  let effectiveCwd = startCwd;
  for (const segment of cmd.split(/(?:&&|\|\||[;&|\n])/)) {
    // Quote-aware tokenization (same as the write path). Whole-command quoting
    // ambiguity is already fail-closed by extractBashWriteTargets (which surfaces
    // the UNVERIFIABLE sentinel and runs unconditionally), so the command is
    // denied regardless; here we just parse quote-correctly for the read check.
    const tokens = tokenizeSegment(segment.trim());
    if (tokens.length === 0) continue;
    // Resolve the EFFECTIVE verb so a demoted reader (`command cat …`,
    // `env X=1 cat …`) is still recognised against READ_TOOL_VERBS.
    const effective = resolveEffectiveTokens(tokens);
    if (!effective) continue;
    // Basename, as in the write path: `/bin/cat x` is `cat`.
    const { operands } = effective;
    const verb = basename(effective.verb);

    // Replay cwd relocation for LATER segments (mirror of the write path).
    if (verb === "cd" || verb === "pushd") {
      effectiveCwd = replayCd(effective, effectiveCwd);
      continue;
    }
    if (verb === "popd") {
      effectiveCwd = null;
      continue;
    }

    // `xargs <read-verb>`: target comes from STDIN — unverifiable → fail closed.
    if (verb === "xargs") {
      const innerVerb = effectiveVerbAfter(effective.rest.slice(1));
      if (XARGS_READ_VERBS.has(innerVerb)) targets.push(UNVERIFIABLE_TARGET);
      continue;
    }

    // `dd if=FILE` reads FILE (the write side, `of=`, is in the write extractor).
    const readOperands =
      verb === "dd"
        ? operands.filter((t) => t.startsWith("if=")).map((t) => t.slice(3))
        : SEARCH_VERBS.has(verb)
          ? searchFileOperands(effective.rest.slice(1))
          : READ_TOOL_VERBS.has(verb) || COPY_READ_VERBS.has(verb)
            ? operands
            : [];
    // Every operand of a file-only verb is a file, and after a cd even a bare word
    // (`cd ~/.kube && cat config`) names a file there; elsewhere the first operand of
    // grep/sed/awk is a pattern or script, so only path-shaped tokens are checked.
    const everyOperand =
      verb === "dd" || !PATTERN_FIRST_VERBS.has(verb) || effectiveCwd !== startCwd;
    for (const tok of readOperands) {
      // Expand an unquoted leading `~` exactly as bash will; `~user`/`~-` cannot be
      // resolved here, so surface the sentinel (classified "outside" → BLOCK).
      const raw = expandTildeWord(tok.trim(), effectiveCwd);
      if (raw === UNVERIFIABLE_TARGET) {
        targets.push(UNVERIFIABLE_TARGET);
        continue;
      }
      if (!raw) continue;
      // Skip non-path-literals: globs, interpolation, fds, sed scripts
      // like `1,5p` / `s/a/b/`, and bare option-ish tokens.
      if (/[*?$`]|\$\{/.test(raw)) continue;
      if (/^[&\d]+$/.test(raw)) continue; // fd redirections, not paths
      if (!everyOperand && !raw.includes("/") && !raw.includes(".")) continue; // not path-shaped
      // A relative read under a dynamic/unknown cd is left best-effort (skip).
      if (!raw.startsWith("/") && effectiveCwd === null) continue;
      // Decide the /dev skip on the LEXICALLY-normalised path (mirror of the
      // write path). `/dev/null` · `/dev/stdin` · `/dev/fd/N` stay under /dev and
      // are skipped; `/dev/../etc/passwd` normalises OUT of /dev and is checked —
      // a bare `/dev/` prefix was a read-side bypass of the out-of-root guard.
      const lexical = resolve(effectiveCwd ?? "/", raw);
      if (lexical === "/dev" || lexical.startsWith("/dev/")) continue;
      targets.push(canonicalize(lexical));
    }
  }

  // RECURSE into `sh -c '<body>'` nested programs for read tools too.
  for (const body of extractShellDashCBodies(cmd)) {
    for (const t of extractBashReadTargets(body)) targets.push(t);
  }
  return targets;
}

export {
  SECRET_GLOB,
  extractBashReadTargets,
  isTrackedEnvTemplate,
  maskTrackedEnvTemplates,
  secretBoundaryReason,
  stripSearchPatterns,
};
