/**
 * Paths and roots: canonicalisation (symlink-safe, bounded), the write-root / read-root
 * boundary from GAFFER_WRITE_ROOTS / GAFFER_READ_ROOTS, the secret-path families, and
 * tilde expansion and cd replay for operands.
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { UNVERIFIABLE_TARGET, normalizeVerb, unquote } from "./shell.mjs";

// Hard bounds so a pathological/deep path can NEVER blow the call stack. An
// unbounded recursion here throws RangeError, and an uncaught throw would exit
// the hook non-2 → Claude Code ALLOWS (fail-open). Both bounds THROW on breach;
// the top-level decision guard turns that throw into a BLOCK (fail-closed).
const MAX_PATH_LEN = 4096; // ~PATH_MAX; anything longer is pathological, not real
const MAX_CANON_DEPTH = 512; // ancestor-walk + symlink-follow recursion ceiling

/**
 * Canonicalise a path symlink-safely, even when it doesn't exist yet (a file
 * about to be written): realpath the longest existing ancestor, then re-append
 * the not-yet-created tail. Fixes false "outside repo" blocks under symlinked
 * roots like macOS /tmp -> /private/tmp.
 *
 * SYMLINK-ESCAPE HARDENING: when the path does not fully exist, we still FOLLOW a
 * final component that is itself a symlink — including a DANGLING one whose target
 * does not exist yet. A write "through" such a link lands at the link's TARGET,
 * which may sit outside the write-root; resolving the target (not re-appending the
 * link's own name) is what makes the out-of-root destination visible to the
 * boundary check. Without this, `ln -s /outside ./link` then a write to `./link`
 * resolved to the in-root `./link` and was allowed while the bytes escaped.
 */
function canonicalize(p, depth = 0) {
  if (typeof p !== "string" || p.length > MAX_PATH_LEN || depth > MAX_CANON_DEPTH) {
    // Refuse to resolve a path we cannot bound safely — fail CLOSED via throw.
    throw new Error("canonicalize: path too long or too deeply nested to resolve safely");
  }
  try {
    // realpathSync resolves ALL symlinks when the whole path exists.
    return realpathSync(p);
  } catch {
    // p does not fully exist yet. If its FINAL component is a symlink (including a
    // dangling one), follow the link to its target and canonicalise THAT so an
    // out-of-root target is exposed to the boundary check.
    try {
      if (lstatSync(p).isSymbolicLink()) {
        const target = readlinkSync(p);
        return canonicalize(resolve(dirname(p), target), depth + 1);
      }
    } catch {
      /* not a symlink / cannot lstat — fall through to the ancestor walk */
    }
    const parent = dirname(p);
    if (parent === p) return p;
    return resolve(canonicalize(parent, depth + 1), basename(p));
  }
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
//
// TOKEN FILES (dashboard-token boundary): the Dispatch REST auth token is
// persisted to `$GAFFER_DATA/dashboard-token`. `$GAFFER_DATA` sits in the
// delivery agent's READ allowlist, so without this a same-user agent could read
// the token off disk and self-approve its own work over the API, defeating the
// env-scrub. We treat the token file — and the general credential-token family
// (`*-token`, `*.token`, `*_token`, `*-token.<ext>`) — as a secret path. The
// `[._-]tokens?` join requires a real separator before `token`, so a bare word
// like `TOKEN` in an unrelated position is not a path match here.
//
// TOKEN-FAMILY PRECISION GUARD (finding 7, re-hardened): a `*[-_.]token(s)?`
// file is a CREDENTIAL by default. The split that keeps legit files readable is
// CODE-extension vs DATA-extension, NOT "has an extension":
//   * a token-named file with a CODE extension is source code (safe to read):
//     `csrf_token.ts`, `auth-token.js`, `refresh-token.ts`, `access-token.tsx`.
//   * a token-named file with a DATA extension (`.json`/`.yaml`/`.txt`/`.env`/…)
//     or NO extension can hold a credential and stays BLOCKED:
//     `access-token.json`, `api_token.json`, `client-token.json`, a bare
//     `access-token`, `secret.token`, `client-token.pem`. `design-tokens.json`
//     and `access-token.json` are structurally identical (`*-token(s).json`) and
//     CANNOT be separated by extension alone — so `.json` MUST NOT be exempt.
// The design-token convention is instead exempted EXPLICITLY, regardless of
// extension: a basename carrying `design[-_.]token(s)` (`design-tokens.json`,
// `design-token.json`, `src/theme/design-tokens.json`), and the W3C
// design-tokens file convention (`*.tokens.json`, `*.tokens`, e.g.
// `theme.tokens.json`).
//
// Implemented as ONE zero-width negative lookahead placed immediately after the
// matched `tokens?`. It fires (exempts → reads through) for exactly three
// TERMINAL forms; each ends in `(?![\w.])`, so only a SINGLE terminal extension
// is exempt and double-extension exfil disguises stay blocked
// (`design-tokens.json.b64`, `x-token.ts.bak`):
//   1. `…token(s)?.<CODE-EXT>`         → a source file
//   2. `…design[-_.]token(s)?[.ext]`   → a design-system token file
//   3. `….tokens[.json]`               → the W3C design-tokens convention
// The design/W3C branches use lookbehind on the just-matched name, so the guard
// stays a drop-in string interpolated identically into every PATH-POSITION rule
// (SECRET_PATH, SECRET_PATH_FRAGMENT, SECRET_ASSIGNMENT) — no per-rule drift.
// UNDECIDABLE-BY-FILENAME (`client-token.js` — code ext but credential-sounding):
// we FAVOUR the code-ext rule and treat it as code. A stored credential is
// virtually never a `.js`/`.ts` file, and the outbound-network / exfil guards
// backstop it. DESIGN NOTE (why this rule stays SMALL): classifying arbitrary
// target-repo `*-token` files by NAME is heuristic defence-in-depth, not a
// guarantee — filename ≠ secret. We block the obvious credential conventions,
// exempt the design-token + code-extension conventions, and STOP; this guard is
// deliberately NOT grown into an ever-larger qualifier chain chasing
// completeness (that churn already produced two OPPOSITE findings on this rule —
// over-block then under-block). When the credential-vs-design call is close we
// PREFER the smaller rule (a novel credential filename slipping is covered by
// the exfil guard; over-blocking design files is the worse product outcome). The
// load-bearing, 100%-reliable blocks are the factory's OWN fixed-name secrets —
// `dashboard-token` and `mcp-runtime.*.json` — each carried by its own
// guard-free alternative in every rule. The data-flow-hiding vectors (SECRET_GLOB, REDIRECT_READ,
// SOURCE_SECRET) carry NO guard and keep over-blocking the whole token family —
// a glob resolves at runtime, and redirect/source consume contents in a
// position no legitimate source-file workflow needs. The exact `dashboard-token`
// file has its own guard-free alternative in every rule, so this guard can
// never weaken it.
const TOKEN_CODE_EXT = String.raw`tsx|ts|jsx|js|mjs|cjs|css|scss|sass|less|vue|svelte`;
const TOKEN_SOURCE_EXT_GUARD = String.raw`(?!(?:\.(?:${TOKEN_CODE_EXT})|(?<=design[._-]tokens?)(?:\.[\w-]+)?|(?<=\.tokens)(?:\.json)?)(?![\w.]))`;
// NOTE: `dashboard-token(\.[\w-]+)?` — the exact token file keeps its own
// alternative WITH an optional extension so `dashboard-token.json` (previously
// caught by the family rule) stays blocked now that the family exempts
// source-code / design-token names.
//
// MCP RUNTIME FILE (claim-token boundary): the factory writes the substituted
// GAFFER_CLAIM_TOKEN into `$GAFFER_DATA/mcp-runtime.<pid>.json` (and the base
// `mcp-runtime.json`). `$GAFFER_DATA` is in the delivery agent's READ allowlist,
// so a rogue agent that reads this file recovers the claim token and can present
// it EXPLICITLY to `submit_ticket_for_review` — re-opening the strand wave-1
// closed by removing the env fallback. So the runtime JSON is a secret path on
// EVERY read vector. Anchored to the `.json` runtime file only: a SOURCE path
// with an `mcp-runtime` DIRECTORY component (`src/mcp-runtime/index.ts`, which
// finding-11 made pass the hygiene rule) is code and stays READABLE. (This is
// the READ rule; the separate hygiene forbidden-fragment `mcp-runtime.` is a
// different rule and stays as finding-7 tightened it.)
const MCP_RUNTIME_FILE = String.raw`mcp-runtime(?:\.\w+)*\.json`;
// PROC ENVIRON (S-H1, Linux claim-token exfil): `/proc/<pid>/environ` — and the
// `/proc/self/environ`, thread `…/task/<tid>/environ`, and `/proc/*/environ` glob
// forms — expose ANOTHER same-user process's environment, including the
// dispatch-mcp process's GAFFER_CLAIM_TOKEN. Treated as a secret path on EVERY
// read vector (Read tool, cat/redirect/source, glob, var-indirection, inline
// interpreter), so no reader path can lift the token. The `proc/` prefix anchors
// it: a plain file named `environ` (no `/proc/` ancestor) is NOT matched. The
// macOS analogue (`ps` with the e/-E env flags) is blocked as a dangerous
// command in lib/dangerous-commands.mjs instead. `[^\s'"]*` never crosses a
// space/quote, so it cannot bleed across command boundaries.
const PROC_ENVIRON = String.raw`proc\/[^\s'"]*\/environ`;
// CLI CREDENTIAL STORES (ambient-credential boundary): the agent keeps the operator's
// HOME, so file-based CLI logins sit on disk next to it — gh (`.config/gh/hosts.yml`),
// docker (`.docker/config.json`), kubectl (`.kube/`), gcloud (`.config/gcloud/`), az
// (`.azure/`), pypi (`.pypirc`), postgres (`.pgpass`), terraform cloud
// (`credentials.tfrc.json`), and Claude's own `.claude.json`. Stripping GITHUB_TOKEN /
// AWS_* from the env does nothing about these, so they are secret paths on every read
// vector. (`.ssh/`, `.aws/`, `.gnupg/` were already secret FRAGMENTS for Bash; they are
// listed here too so the Read/Write tools and the search tools agree.)
const CLI_CREDENTIAL_PATHS = String.raw`\.config\/gh\/.*|\.config\/gcloud\/.*|\.docker\/config\.json|\.kube\/.*|\.azure\/.*|\.ssh\/.*|\.aws\/.*|\.gnupg\/.*|\.pypirc|\.pgpass|credentials\.tfrc\.json|\.claude\.json`;
// THE FACTORY KEY (signed gate events): approvals and tester verdicts are signed with a key
// in ${XDG_CONFIG_HOME:-$HOME/.config}/gaffer/keys (packages/dispatch/src/events/
// gateSeal.ts). An agent that read it could sign a forged approval, so the keys directory,
// and `.config/gaffer` above it, are secret paths on every read and write vector. The
// directory always ends in `gaffer/keys` (no knob relocates it), whatever XDG_CONFIG_HOME
// says, so the name alone identifies it. Under SANDBOX_PROVIDER=none this is the ONLY
// guard between an agent and the key (SECURITY.md).
const FACTORY_KEYS_PATH = String.raw`gaffer\/keys(?:\/.*)?|\.config\/gaffer(?:\/.*)?`;
// The same for matching anywhere in a raw command (not end-anchored).
const FACTORY_KEYS_FRAGMENT = String.raw`gaffer\/keys(?![\w.-])|\.config\/gaffer(?![\w.-])`;
// Same families for matching anywhere in a raw command (not end-anchored).
const CLI_CREDENTIAL_FRAGMENT = String.raw`credentials\.tfrc\.json|\.config\/gh\/|\.config\/gcloud\/|\.docker\/config\.json\b|\.kube\/|\.azure\/|\.pypirc\b|\.pgpass\b|\.claude\.json\b`;
// ENV-FILE and CREDENTIAL-NAME fragments (false-positive fix). The old `\.env\b` and
// bare `credentials\b|secrets?\b` matched ANY word, so `grep -rn "process.env.PORT"
// src`, `sed -i s/process.env.A/process.env.B/`, `pnpm vitest run test/secrets.test.ts`
// and `grep -rn getSecret src` were refused as secret reads. These forms match only
// a PATH-shaped mention:
//   ENV_FILE_FRAGMENT  `.env` / `.env.<x>` not glued to an identifier (`./.env`,
//                      `$HOME/.env`, `.env.local` — never `process.env`), or a
//                      `<name>.env` env-file token (`prod.env`) other than the
//                      runtime env objects (`process.env`, `import.meta.env`, …).
//                      `.env-local` / `.env_prod` (a `-` or `_` suffix) and
//                      `prod.env.bak`-style backups count too.
//   CRED_NAME_FRAGMENT a basename that IS `credentials[.json|.toml|…]` or
//                      `secret(s).<data-ext>`, optionally behind a `<name>_` /
//                      `<name>-` prefix (`gcp-credentials.json`, `aws_credentials`,
//                      `app-secrets.yaml`, `client_secret.json`), Google's
//                      `client_secret_<id>.json`, or a `secret(s)/` directory.
//                      `getSecret` and `secrets.test.ts` are not data files.
// `*.key` stays blocked (private keys use it). Applied in lock-step to the crew
// classifier (packages/crew/src/safety/commandGuard.ts).
const ENV_FILE_FRAGMENT = String.raw`(?<![\w$])\.env(?:[._-][\w-]+)?(?![\w-])|(?<![\w$.])(?!(?:process|import\.meta|Deno|Bun)\.env(?![\w.-]))[\w-]+(?:\.[\w-]+)*\.env(?:\.(?:bak|backup|old|orig|save|local))?(?![\w.-])`;
const CRED_NAME_FRAGMENT = String.raw`(?<![\w$.-])(?:\w[\w-]*[_-]|\.)?credentials(?:\.(?:json|toml|ya?ml|ini|txt))?(?![\w.-])|(?<![\w$.-])(?:\w[\w-]*[_-])?secrets?\.(?:json|ya?ml|txt|env|toml|ini)(?![\w.-])|(?<![\w$.-])client_secret[\w.-]*\.json(?![\w.-])|(?<![\w$.-])secrets?\/`;
// Committed env TEMPLATES (`.env.example` & co.) document variable NAMES. A TRACKED
// one is already in history, so the agent may read, edit, diff and stage it (an AC
// like "document the new var in .env.example" was undeliverable). An untracked one
// could be a renamed real `.env`, so it stays a secret; see isTrackedEnvTemplate.
const ENV_TEMPLATE = /(^|\/)\.env\.(?:example|sample|template|dist|defaults)$/i;
const SECRET_PATH = new RegExp(
  String.raw`(^|\/)(\.env([._-][\w-]+)?|[\w-][\w.-]*\.env|\.netrc|\.npmrc|\.git-credentials|${CLI_CREDENTIAL_PATHS}|${FACTORY_KEYS_PATH}|id_[a-z0-9]+|.*\.pem|.*\.key|.*\.p12|(\.|\w[\w-]*[_-])?credentials(\.(json|toml|ya?ml|ini|txt))?|(\w[\w-]*[_-])?secrets?\.(json|ya?ml|txt|toml|ini)|client_secret[\w.-]*\.json|${MCP_RUNTIME_FILE}|${PROC_ENVIRON}|dashboard-token(\.[\w-]+)?|[\w.-]*[._-]tokens?${TOKEN_SOURCE_EXT_GUARD}(\.[\w-]+)?)$`,
  "i",
);
const GIT_INTERNAL = /(^|\/)\.git(\/|$)/;
// The agent's own settings file wires the PreToolUse safety hook (the runner templates
// it into each worktree). A write to it — via the Write/Edit tool or a bash redirect —
// could strip the very hook that enforces this boundary, so it is protected exactly
// like .git/ internals: never agent-writable. (`.credentials.json` above was added for
// the same reason: `credentials` alone did not match Claude's `~/.claude/.credentials.json`.)
const AGENT_SETTINGS = /(^|\/)\.claude\/settings(\.local)?\.json$/i;

// =====================================================================
// TILDE EXPANSION (operand resolution)
// ---------------------------------------------------------------------
// Bash expands an UNQUOTED leading `~` before the command runs: `~` and `~/x`
// become $HOME and $HOME/x, `~+` the cwd, `~-` the previous cwd, `~user` that
// user's home. The extractors used to resolve the raw operand, so `~/x` landed at
// <cwd>/~/x — INSIDE the write-root — and `printf x >> ~/.zshrc`, `rm -r -f ~`,
// `git -C ~ checkout -b x` and `cat ~/.config/gh/hosts.yml` all passed the
// boundary while the real target sat in the operator's home.
//
// expandTildeWord takes the RAW shell token (quotes still on): a token whose first
// character is a quote is a literal relative path (`"~/x"` is <cwd>/~/x, exactly
// what bash does) and only an unquoted leading tilde expands. `~` and `~/…` map to
// os.homedir() (the agent's HOME, inherited by this hook). `~+` maps to the
// effective cwd when that is known. `~-` and `~user` cannot be resolved by a
// stateless hook (no dir stack, no passwd lookup on purpose), so they return the
// UNVERIFIABLE_TARGET sentinel and the caller fails CLOSED. Inline-interpreter
// string literals (python/node/awk) are deliberately NOT routed through here:
// those languages never expand `~`, so `open("~/x")` really is a cwd-relative path.
function expandTildeWord(rawToken, cwd) {
  const t = rawToken.trim();
  if (!t.startsWith("~")) return unquote(t);
  const m = t.match(/^~([^/]*)([\s\S]*)$/);
  const user = m[1];
  // Bash removes quotes in the rest of the word too (`~/"a b"` → $HOME/a b).
  const rest = m[2].replace(/["']/g, "");
  if (user === "") return homedir() + rest;
  if (user === "+") return cwd === null ? UNVERIFIABLE_TARGET : cwd + rest;
  return UNVERIFIABLE_TARGET; // `~-` (dir stack) or `~user` (another home)
}

/**
 * Tilde expansion for a file-tool path (Write/Edit/Read/Grep/Glob): Claude Code
 * expands a leading `~` to the home directory for these, so `~/.zshrc` must be
 * checked as $HOME/.zshrc. There is no shell quoting here. A `~user` form returns
 * null so the caller blocks it (fail closed) rather than resolving it under cwd.
 */
function expandTildePath(filePath) {
  if (filePath === "~" || filePath.startsWith("~/")) return homedir() + filePath.slice(1);
  if (filePath.startsWith("~")) return null;
  return filePath;
}

/**
 * The effective cwd after one `cd`/`pushd` segment, for the extractors that replay
 * directory changes left to right. A literal destination resolves; `~` and `~/…`
 * expand to $HOME like any operand (`cd ~/.config/gh && cat hosts.yml` reads the
 * real gh store, so the read must be judged there), and a bare `cd` IS $HOME. Only
 * what a stateless hook cannot know returns null (the caller then fails closed or
 * skips): `cd -`, `pushd`/`pushd +N` (dir stack), `~user` / `~-`, and a `$`, backtick
 * or glob destination. An absolute destination resolves even after an unknown cwd.
 */
function replayCd(effective, cwd) {
  const args = effective.rest.slice(1);
  let k = 0;
  while (k < args.length && /^-[LPe@]+$/.test(normalizeVerb(args[k]))) k += 1;
  if (args[k] === "--") k += 1;
  const arg = args[k];
  if (arg === undefined) return effective.verb === "cd" ? canonicalize(homedir()) : null;
  if (/[*?$`]/.test(arg) || /^[-+]/.test(unquote(arg))) return null;
  const p = expandTildeWord(arg, cwd);
  if (p === UNVERIFIABLE_TARGET || p === "") return null;
  if (p.startsWith("/")) return canonicalize(p);
  return cwd === null ? null : canonicalize(resolve(cwd, p));
}

export {
  AGENT_SETTINGS,
  CLI_CREDENTIAL_FRAGMENT,
  CRED_NAME_FRAGMENT,
  ENV_FILE_FRAGMENT,
  ENV_TEMPLATE,
  FACTORY_KEYS_FRAGMENT,
  GIT_INTERNAL,
  MCP_RUNTIME_FILE,
  PROC_ENVIRON,
  SECRET_PATH,
  TOKEN_SOURCE_EXT_GUARD,
  canonicalize,
  classifyRootAccess,
  expandTildePath,
  expandTildeWord,
  isInsideAny,
  isInsideRoot,
  replayCd,
  resolveRoots,
};
