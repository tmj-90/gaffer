/**
 * Writes: the target paths of a Bash command's write operations (redirects, tee, cp/mv,
 * sed -i, dd, awk redirects, containers, git -C, xargs-fed writers, nested shells).
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { basename, resolve } from "node:path";
import {
  canonicalize,
  expandTildeWord,
  isInsideAny,
  isInsideRoot,
  replayCd,
  resolveRoots,
} from "./paths.mjs";
import {
  UNVERIFIABLE_TARGET,
  commandQuotingAmbiguous,
  tokenizeSegment,
  unquote,
} from "./shell.mjs";
import { effectiveVerbAfter, extractShellDashCBodies, resolveEffectiveTokens } from "./verbs.mjs";

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
// Container runtimes: management groups that precede the subcommand
// (`docker container run`, `docker compose run`, `podman pod create`), the
// subcommands themselves (so one is never mistaken for a global flag's value), and
// the `run`/`create` short options that take a value (`-e X`, `-v SRC:DST`).
const DOCKER_GROUPS = new Set(["container", "compose", "service", "pod"]);
const DOCKER_SUBCOMMANDS = new Set(["run", "create", "cp", "exec", "build", "start"]);
const DOCKER_SHORT_VALUE_FLAGS = new Set([..."acehlmpuvw"]);

/**
 * git subcommands that never write the work tree or the repository (`git -C <dir> …`
 * with one of these is a read, judged by the read rules; any other subcommand run in
 * another directory is a write there).
 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status",
  "log",
  "show",
  "diff",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "cat-file",
  "blame",
  "grep",
  "describe",
  "shortlog",
  "merge-base",
  "name-rev",
  "for-each-ref",
  "show-ref",
  "whatchanged",
  "version",
  "help",
]);

function extractBashWriteTargets(cmd) {
  const targets = [];
  // Effective cwd for resolving RELATIVE targets. Updated as the segment loop
  // replays `cd`/`pushd` left-to-right, so a `cd <outside> && echo x > rel`
  // resolves `rel` against <outside> — not the process cwd — closing a
  // write-boundary escape. `cd ~/x` and a bare `cd` resolve under $HOME (see
  // replayCd). `null` = a dynamic/unknown cd (`cd $VAR`, `cd -`, `cd ~user`,
  // `popd`): the effective dir is unprovable, so any subsequent RELATIVE target
  // fails closed (UNVERIFIABLE). Absolute targets are unaffected by cd and stay
  // exactly resolvable.
  let effectiveCwd = process.cwd();
  const add = (raw) => {
    if (!raw) return;
    // Expand an unquoted leading `~` the way bash will (see expandTildeWord); an
    // unresolvable `~user` / `~-` fails closed.
    const p = expandTildeWord(raw.trim(), effectiveCwd);
    if (p === UNVERIFIABLE_TARGET) {
      targets.push(UNVERIFIABLE_TARGET);
      return;
    }
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
    // Skip process substitutions / fds we can't resolve to a real path.
    if (/^[&\d]+$/.test(p)) return;
    // A RELATIVE target under a dynamic/unknown cd (effectiveCwd === null) lands
    // somewhere we cannot prove — fail closed. Absolute targets ignore cwd.
    if (!p.startsWith("/") && effectiveCwd === null) {
      targets.push(UNVERIFIABLE_TARGET);
      return;
    }
    // Decide the /dev skip on the LEXICALLY-normalised path (`..` collapsed, but
    // symlinks NOT followed), then push the fully-canonicalised target. Two
    // failure modes are closed at once:
    //   • `/dev/../<write-root>/.claude/settings.json` normalises OUT of /dev, so
    //     it is NOT skipped — closing a total write-boundary bypass (the agent
    //     could otherwise rewrite its own settings to remove this hook).
    //   • `/dev/stdin` · `/dev/stdout` · `/dev/fd/N` stay lexically under /dev, so
    //     they ARE skipped — realpath would resolve these to /proc/self/fd/* and
    //     wrongly surface a legitimate device write as an out-of-root target.
    const lexical = resolve(effectiveCwd ?? "/", p);
    if (lexical === "/dev" || lexical.startsWith("/dev/")) return;
    targets.push(canonicalize(lexical));
  };

  // FAIL-CLOSED gate (S-1/S-4): if the WHOLE command has quoting we cannot
  // resolve (a $'…'/$"…" ANSI-C/locale string, or a dangling quote), a write
  // verb + target could be hidden in it — surface the UNVERIFIABLE sentinel
  // (classified "outside" → BLOCK). Judged over the whole command so the
  // quote-naive segment splitter cannot manufacture false unbalance from a `;`
  // inside a legitimate quoted body. See commandQuotingAmbiguous.
  if (commandQuotingAmbiguous(cmd)) targets.push(UNVERIFIABLE_TARGET);

  // Per-segment parsing, LEFT-TO-RIGHT so `cd`/`pushd` can move the effective
  // cwd for subsequent segments (quote-aware tokenizer so a quoted assignment
  // value with a space no longer hides the real verb/target). The splitter must
  // NOT cut inside the redirect operators `>&` `>>&` `&>` `&>>` `>|`, whose `&`/
  // `|` would otherwise read as a control separator and strand the redirect
  // target in its own segment (it did — those forms then escaped the boundary
  // once the redirect scan moved per-segment): a single `&` preceded/followed by
  // `>`, and a single `|` preceded by `>`, are redirect syntax, not separators.
  for (const segment of cmd.split(/(?:&&|\|\||;|\n|(?<![>&])&(?!>)|(?<!>)\|)/)) {
    const tokens = tokenizeSegment(segment.trim());
    if (tokens.length === 0) continue;
    // Resolve the EFFECTIVE verb: strip leading `VAR=value` assignments and no-op
    // wrapper commands so a demoted verb (`env tee …`, `VAR=1 mv …`) is still seen.
    const effective = resolveEffectiveTokens(tokens);

    // `cd`/`pushd`/`popd` relocate the effective cwd for LATER segments. A
    // provable dir (a literal, `~/…`, or a bare `cd` → $HOME) updates it; a
    // dynamic/unknown target (`cd $VAR`, `cd -`, `cd ~user`, or `popd` off an
    // unknown stack) poisons it to null so any subsequent relative write fails
    // closed. cd carries no
    // write target of its own → handled here, before the redirect scan.
    if (effective && (effective.verb === "cd" || effective.verb === "pushd")) {
      effectiveCwd = replayCd(effective, effectiveCwd);
      continue;
    }
    if (effective && effective.verb === "popd") {
      effectiveCwd = null; // dir stack is unknown to a stateless hook → poison
      continue;
    }

    // Output redirection: `> file`, `>> file`, `2> file`, `&> file`, plus the
    // noclobber/csh override forms `>| file`, `>& file`, `>>& file` (the optional
    // `[|&]` after the arrow is consumed so the destination is captured, not the
    // operator). fd-duplication targets like `2>&1` / `>&2` route their bare
    // `1`/`2` into the `/^[&\d]+$/` skip guard in add(). Scanned per-segment so
    // the redirect resolves against the effective cwd in force here.
    for (const m of segment.matchAll(
      /(?:^|\s)(?:[0-9]*|&)>>?[|&]?\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g,
    )) {
      add(m[1]);
    }
    // `dd of=FILE`.
    for (const m of segment.matchAll(/\bof=("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)) add(m[1]);

    if (!effective) continue;
    // Dispatch on the verb's basename: `/bin/cp x /etc/y` and `/usr/bin/docker run
    // -v /:/h` are `cp` and `docker` (a path-qualified verb used to skip every branch).
    const { operands } = effective;
    const verb = basename(effective.verb);

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
    } else if (verb === "rsync" || verb === "scp") {
      // `rsync [opts] SRC… DEST` / `scp [opts] SRC… DEST` — the LAST operand is
      // the destination and a LOCAL dest writes to the filesystem, so an
      // out-of-root dest is a boundary escape (e.g. `scp remote:x /etc/cron.d/j`).
      // A REMOTE dest (`host:path`, `user@host:path`) is a network upload, not a
      // local write — skip it here (secret-exfil of a remote upload is caught by
      // the secret guard), and only surface local destinations to the boundary.
      const dest = operands.length >= 1 ? unquote(operands[operands.length - 1]) : "";
      const isRemote = /^[^/]*@[^/]*:|^[A-Za-z0-9._-]+:/.test(dest);
      if (dest && !isRemote) add(operands[operands.length - 1]);
    } else if (verb === "mkdir" || verb === "touch" || verb === "rm" || verb === "truncate") {
      // `truncate -s 0 FILE` — operands already have `-flags` stripped, but
      // `truncate`'s `-s` takes a value (`0`, `10K`). Drop a leading size arg.
      const ops =
        verb === "truncate" ? operands.filter((o) => !/^[0-9]+[KMGkmg]?$/.test(o)) : operands;
      for (const op of ops) add(op);
    } else if (verb === "sed" && /\s-[a-z]*i/.test(segment)) {
      // `sed -i ... FILE` — in-place edit; the file is the last operand.
      if (operands.length >= 1) add(operands[operands.length - 1]);
    } else if ((verb === "perl" || verb === "ruby") && /\s-[a-z]*i/.test(segment)) {
      // `perl -pi -e PROG FILE…` / `ruby -i -pe PROG FILE…` — in-place edit of every
      // operand after the program (or script): each FILE is written.
      for (const op of operands.slice(1)) add(op);
    } else if (AWK_FAMILY.has(verb)) {
      // awk/gawk/mawk: scan the program body for `> path` redirect write targets.
      // The program is the first non-flag operand (the quoted script).
      for (const op of operands) {
        for (const t of extractAwkRedirectTargets(unquote(op))) targets.push(t);
      }
    } else if (verb === "tar") {
      // `tar -x …` EXTRACTS files onto the filesystem. The archive's member
      // paths are invisible to us, so even an in-root `-C <dir>` can be escaped
      // by a `../`-traversal entry inside the archive. We therefore (a) check any
      // explicit `-C <dir>` destination, and (b) ALWAYS surface UNVERIFIABLE for
      // an extraction, failing closed on archive-relative traversal we cannot
      // see. (Create/list/append — `-c`/`-t`/`-r`/`-u` without `-x` — are not
      // extractions and fall through untouched.) See tokenizeSegment rationale.
      const isExtract = /(?:^|\s)-?-?(?:[A-Za-z]*x[A-Za-z]*|-extract\b)/.test(segment);
      if (isExtract) {
        // Honour an explicit `-C <dir>` / `--directory=<dir>` change-dir target.
        const cdir = segment.match(/(?:^|\s)(?:-C\s+|--directory[=\s])("[^"]+"|'[^']+'|[^\s;&|]+)/);
        if (cdir) add(cdir[1]);
        targets.push(UNVERIFIABLE_TARGET); // archive-relative traversal → fail closed
      }
    } else if (verb === "curl") {
      // `curl -o FILE` / `-oFILE` / `--output FILE` / `--output=FILE` writes the
      // response body to an arbitrary path — an out-of-root write (and, via
      // `-o /dev/../…/.claude/settings.json`, a hook-removal surface) that the
      // redirect/verb scans above never saw. The destination is parsed from the
      // raw segment because the tokenizer strips `-o` as a flag. (`-O`/`--remote-name`
      // writes cwd/<remote-name>; with `--output-dir DIR` that dir is the write
      // target, so surface it too — an outside DIR is then blocked.)
      for (const m of segment.matchAll(
        /(?:^|\s)(?:-o\s*|--output[=\s]+|--output-dir[=\s]+)("[^"]+"|'[^']+'|[^\s;&|<>]+)/g,
      )) {
        add(m[1]);
      }
    } else if (verb === "wget") {
      // `wget -O FILE` / `-OFILE` / `--output-document FILE|=FILE` writes the
      // download to an arbitrary path (wget's `-o` is a LOGFILE, not output, and
      // `-O` is capital — hence the tool-specific scan, distinct from curl's).
      for (const m of segment.matchAll(
        /(?:^|\s)(?:-O\s*|--output-document[=\s]+)("[^"]+"|'[^']+'|[^\s;&|<>]+)/g,
      )) {
        add(m[1]);
      }
    } else if (verb === "docker" || verb === "podman" || verb === "nerdctl") {
      // A container BIND MOUNT hands the container read/write access to its host
      // SOURCE path — `docker run -v /:/host …` is the whole host filesystem (and,
      // for a docker-group user, root). Treat every bind source as a write target so
      // it must sit inside a write-root; a named volume (no `/`, `.` or `~`) is not a
      // host path. `docker cp <ctr>:<src> <dest>` writes <dest> on the host. (Host
      // namespaces / --privileged / -H are deny-listed in lib/dangerous-commands.mjs.
      // A compose file's volumes are invisible here — the documented residual.)
      //   The subcommand is found past the runtime's GLOBAL flags, whose values are
      // not subcommands (`docker --log-level debug run …`), and past a management
      // group (`docker container run`, `docker compose -f x.yml run`): a non-flag
      // token straight after a flag is taken as that flag's value. Short flags may be
      // combined (`-itv /:/host`): the first value-taking letter takes the rest of the
      // token (minus a leading `=`, so `-v=/:/h` is `/`) or the next token.
      const rawArgs = effective.rest.slice(1);
      let sub = -1;
      let afterFlag = false;
      for (let k = 0; k < rawArgs.length; k += 1) {
        const tk = rawArgs[k];
        if (tk.startsWith("-")) {
          afterFlag = !tk.includes("=");
        } else if (DOCKER_GROUPS.has(tk)) {
          afterFlag = false;
        } else if (DOCKER_SUBCOMMANDS.has(tk) || !afterFlag) {
          sub = k;
          break;
        } else {
          afterFlag = false;
        }
      }
      const subVerb = sub === -1 ? "" : rawArgs[sub];
      if (subVerb === "run" || subVerb === "create") {
        const bindSource = (src) => {
          if (/^[./~$]/.test(src) || src.includes("/")) add(src);
        };
        for (let k = sub + 1; k < rawArgs.length; k += 1) {
          const tk = rawArgs[k];
          let vol = null;
          let mount = null;
          if (tk === "--volume") vol = rawArgs[(k += 1)];
          else if (tk.startsWith("--volume=")) vol = tk.slice("--volume=".length);
          else if (tk === "--mount") mount = rawArgs[(k += 1)];
          else if (tk.startsWith("--mount=")) mount = tk.slice("--mount=".length);
          else if (/^-[A-Za-z]/.test(tk)) {
            for (let c = 1; c < tk.length; c += 1) {
              if (!DOCKER_SHORT_VALUE_FLAGS.has(tk[c])) continue;
              let value = tk.slice(c + 1).replace(/^=/, "");
              if (!value) value = rawArgs[(k += 1)] ?? "";
              if (tk[c] === "v") vol = value;
              break;
            }
          }
          if (vol) bindSource(vol.replace(/["']/g, "").split(":")[0]);
          if (mount) {
            const kv = Object.fromEntries(
              mount
                .replace(/["']/g, "")
                .split(",")
                .map((pair) => pair.split("=")),
            );
            const src = kv.source ?? kv.src;
            if (kv.type === "bind" && src) add(src);
          }
        }
      } else if (subVerb === "cp") {
        const cpOps = rawArgs.slice(sub + 1).filter((tk) => !tk.startsWith("-"));
        const dest = cpOps.length >= 2 ? cpOps[cpOps.length - 1] : "";
        if (dest && !/^[^/]+:/.test(unquote(dest))) add(dest);
      }
    } else if (verb === "git") {
      // `git [-C dir] worktree add [-b <branch>] <path>` creates a NEW worktree
      // directory at <path>; if <path> is outside the write-roots it writes outside
      // the boundary. Scan the RAW tokens after `git` (a leading `-C <dir>` survives
      // as a bare `dir` token, so we scan for the `worktree add` adjacency rather
      // than assuming a fixed index) and take the first non-flag token after `add`,
      // skipping the VALUE of a value-taking flag. The flag-stripped operand list
      // used to leave the `-b`/`-B` branch NAME in the path slot, so
      // `worktree add -b x /outside/wt` checked cwd/x (in-root) and the out-of-root
      // worktree dir escaped the boundary. (The branch the `-b` creates is checked
      // separately by branchCreationBoundaryReason.)
      const rawGit = effective.rest.slice(1);
      // `git -C <dir>` / `--work-tree <dir>` / `--git-dir <dir>` run git IN another
      // directory: a mutating subcommand there (checkout, apply, add, init, reset, mv,
      // stash, commit, config, …) writes files in <dir>, so `git -C "$GAFFER_DATA"
      // checkout -- settings.json` rewrote the runner's own settings past the write
      // boundary. Every such dir is a write target unless the subcommand is one of
      // the read-only ones below (the boundary then judges it like any other write;
      // a dynamic dir fails closed). Unknown subcommands count as writes.
      {
        const gitDirs = [];
        let sub = "";
        for (let k = 0; k < rawGit.length; k += 1) {
          const tk = unquote(rawGit[k]);
          if (tk === "-C" || tk === "--git-dir" || tk === "--work-tree") {
            gitDirs.push(rawGit[(k += 1)] ?? "");
            continue;
          }
          const eqd = tk.match(/^--(?:git-dir|work-tree)=(.*)$/);
          if (eqd) {
            gitDirs.push(eqd[1]);
            continue;
          }
          if (/^-C./.test(tk)) {
            gitDirs.push(tk.slice(2));
            continue;
          }
          if (
            tk === "-c" ||
            tk === "--namespace" ||
            tk === "--exec-path" ||
            tk === "--config-env"
          ) {
            k += 1; // the option's value
            continue;
          }
          if (tk.startsWith("-")) continue;
          sub = tk;
          break;
        }
        if (gitDirs.length > 0 && sub && !GIT_READ_ONLY_SUBCOMMANDS.has(sub)) {
          // A READ-root repo keeps its own rules (branch creation is judged by
          // branchCreationBoundaryReason; a plain checkout there stays allowed) —
          // except under $GAFFER_DATA, the runner's state, which is never a repo an
          // agent works in. Everywhere else the dir is a write target.
          const roots = resolveRoots();
          const data = process.env.GAFFER_DATA
            ? canonicalize(resolve(process.env.GAFFER_DATA))
            : "";
          for (const d of new Set(gitDirs)) {
            const p = d === "" ? UNVERIFIABLE_TARGET : expandTildeWord(d.trim(), effectiveCwd);
            if (
              p === UNVERIFIABLE_TARGET ||
              /[$`]/.test(p) ||
              (!p.startsWith("/") && effectiveCwd === null)
            ) {
              targets.push(UNVERIFIABLE_TARGET);
              continue;
            }
            const c = canonicalize(resolve(effectiveCwd ?? "/", p));
            const inData = data !== "" && isInsideRoot(data, c);
            if (!inData && isInsideAny(roots.readRoots, c)) continue;
            add(d);
          }
        }
      }
      const wi = rawGit.indexOf("worktree");
      if (wi !== -1 && rawGit[wi + 1] === "add") {
        for (let k = wi + 2; k < rawGit.length; k += 1) {
          const t = rawGit[k];
          if (t === "-b" || t === "-B" || t === "--reason") {
            k += 1; // consume the flag's value
            continue;
          }
          if (t.startsWith("-")) continue;
          add(t);
          break;
        }
      }
      // `git clone <url> <DIR>` writes a whole tree at DIR. The URL is the first
      // operand after `clone`; an EXPLICIT second operand is the target dir, so
      // an out-of-root DIR is a boundary escape. With no DIR, git clones into
      // cwd/<name> (in-root when cwd is) — nothing to surface.
      const ci = operands.indexOf("clone");
      if (ci !== -1 && operands.length > ci + 2) add(operands[ci + 2]);
    }
  }

  // RECURSE into `sh -c '<body>'` / `bash -lc "<body>"` nested programs: the
  // quoted body is a full program that can carry its own write ops.
  for (const body of extractShellDashCBodies(cmd)) {
    for (const t of extractBashWriteTargets(body)) targets.push(t);
  }
  return targets;
}

export { extractBashWriteTargets };
