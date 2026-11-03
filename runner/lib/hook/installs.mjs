/**
 * Installs: the bootstrap-only install allowance and --ignore-scripts on every permitted
 * install.
 *
 * Part of the safety hook's decision, split out of runner/safety-hook-core.mjs (the one
 * module the hook and the tests import); see the map in its header.
 */

import { basename, resolve } from "node:path";
import { DENY_COMMANDS } from "./deny-list.mjs";
import { canonicalize, expandTildeWord, isInsideRoot, replayCd } from "./paths.mjs";
import { UNVERIFIABLE_TARGET, normalizeVerb, tokenizeSegment } from "./shell.mjs";
import { resolveEffectiveTokens } from "./verbs.mjs";

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
// package-manager DENY rules (install/add, ci/update/remove, rebuild/link), ONLY
// when the flag is set and the cwd is inside the bootstrap dir, and each install
// SEGMENT is then judged on its own (bootstrapInstallReason). Every other blocked
// op (brew, sudo, rm -rf, force-push, download-and-run, secret reads, writes/reads
// outside roots) stays fully gated. A plain `npm install` with no flag, or one
// outside the bootstrap dir, is still BLOCKED.
function bootstrapInstallDir() {
  if (process.env.GAFFER_BOOTSTRAP_INSTALL !== "1") return null;
  const dir = process.env.GAFFER_BOOTSTRAP_DIR;
  if (!dir) return null;
  const bootDir = canonicalize(resolve(dir));
  // The command must run inside the bootstrap repo dir: cwd is inside it.
  const cwd = canonicalize(process.cwd());
  return isInsideRoot(bootDir, cwd) ? bootDir : null;
}

// Install flags that relocate WHERE the install lands (the value is a directory).
const INSTALL_DIR_FLAGS = new Set([
  "--prefix",
  "-C",
  "--dir",
  "--cwd",
  "--modules-folder",
  "--global-folder",
  "--global-dir",
  "--global-bin-dir",
  "--store-dir",
  "--virtual-store-dir",
]);

/**
 * Judge a bootstrap tick's install command SEGMENT BY SEGMENT (the allowance used to
 * be decided once for the whole string, so one `--ignore-scripts` anywhere covered
 * every install, and `-g` / `--prefix /usr/local` / `pnpm -C /elsewhere` escaped the
 * fresh repo). Returns a block reason, or null when every install segment is a
 * scoped, script-free install into the bootstrap dir. Each install segment must:
 *   • run with an effective cwd inside the bootstrap dir (cd/pushd replayed; a
 *     dynamic cd, `popd` or a cd anywhere — including inside `sh -c` — that does
 *     not provably stay inside voids the allowance);
 *   • carry --ignore-scripts itself (and no re-enable form);
 *   • not be global (-g in any short-flag cluster, --global*, --location, `yarn global`);
 *   • relocate (--prefix, -C, --dir, --cwd, --global-dir, …) only to a literal dir
 *     inside it;
 *   • not point at another config (--userconfig, --globalconfig, --config.<key>);
 * and the command as a whole must not set a package-manager config variable
 * (npm_config_* / yarn_*, inline or exported in an earlier segment), nor carry a
 * `$` or backtick (`G=-g; npm install $G x`, `$(printf -- --global)`: an expansion
 * can produce any flag). The flags are judged on the words bash will pass, quotes
 * and backslashes removed, so `'-g'`, `-\g`, `--pre""fix` and `"--prefix=/x"` are
 * the flags they spell.
 * HONEST LIMIT: the hook is stateless, so "the FIRST install only" is not enforced
 * across tool calls; the tick's npm_config_ignore_scripts=true env (whose override
 * is deny-listed) is what keeps a later call script-free.
 */
function bootstrapInstallReason(cmd, bootDir) {
  const installRules = DENY_COMMANDS.filter((r) => r.install);
  if (!installRules.some((r) => r.re.test(cmd))) return null;
  const outside =
    "install relocates outside the fresh bootstrap repo — the bootstrap allowance covers only an install INSIDE it";
  if (/[$`]/.test(cmd)) {
    return `install command carries a shell expansion (it can produce any flag: global, prefix, config) — the bootstrap allowance covers only a literal install — "${cmd.slice(0, 120)}"`;
  }
  const cwd = canonicalize(process.cwd());
  // Any directory change anywhere in the command (a nested `sh -c` body included)
  // must provably stay inside the bootstrap dir.
  for (const m of cmd.matchAll(
    /(?:^|[\s;&|(`'"])(cd|pushd|popd)(?=$|[\s;&|)`'"])[ \t]*([^\s;&|)'"`]*)/g,
  )) {
    const dest = m[2];
    if (m[1] === "popd" || !dest || /[$`*?]/.test(dest) || dest === "-") return outside;
    const p = expandTildeWord(dest, cwd);
    if (p === UNVERIFIABLE_TARGET || !isInsideRoot(bootDir, canonicalize(resolve(cwd, p)))) {
      return outside;
    }
  }
  // A package-manager config variable set ANYWHERE in the command (`export
  // npm_config_global=true; npm install …`, `X=1; npm install`) reaches the install
  // through the environment, so it is judged over the whole command, not per segment.
  if (/(?:^|[\s;&|(`'"])(?:npm_config_|yarn_)\w*=/i.test(cmd)) {
    return `install command sets a package-manager config variable (can re-enable scripts, go global or relocate the install) — "${cmd.slice(0, 120)}"`;
  }
  let effectiveCwd = cwd;
  let installSegments = 0;
  for (const segment of cmd.split(/(?:&&|\|\||;|\n|(?<![>&])&(?!>)|(?<!>)\|)/)) {
    const tokens = tokenizeSegment(segment.trim());
    if (tokens.length === 0) continue;
    const effective = resolveEffectiveTokens(tokens);
    if (effective && (effective.verb === "cd" || effective.verb === "pushd")) {
      effectiveCwd = replayCd(effective, effectiveCwd);
      continue;
    }
    if (!installRules.some((r) => r.re.test(segment))) continue;
    installSegments += 1;
    const shown = segment.trim().slice(0, 120);
    if (effectiveCwd === null || !isInsideRoot(bootDir, effectiveCwd))
      return `${outside}: "${shown}"`;
    // The words the package manager will receive (quote removal, as bash does it).
    const words = tokens.map(normalizeVerb);
    if (!installHasIgnoreScripts(words.join(" "))) {
      return `permitted install must pass --ignore-scripts on EVERY install (dependency lifecycle scripts are arbitrary code execution) — "${shown}"`;
    }
    for (let k = 0; k < words.length; k += 1) {
      const w = words[k];
      const eq = w.indexOf("=");
      const flag = eq > 0 ? w.slice(0, eq) : w;
      if (INSTALL_DIR_FLAGS.has(flag)) {
        const v = eq > 0 ? w.slice(eq + 1) : words[(k += 1)];
        if (v === undefined || v === "" || v.startsWith("~")) return `${outside}: "${shown}"`;
        if (!isInsideRoot(bootDir, canonicalize(resolve(effectiveCwd, v))))
          return `${outside}: "${shown}"`;
        continue;
      }
      if (
        /^-[A-Za-z]*g/.test(w) ||
        /^--(?:global|location)(?:$|[=-])/.test(w) ||
        (w === "global" && basename(effective?.verb ?? "") === "yarn")
      ) {
        return `global install (lands on PATH outside the bootstrap repo) — "${shown}"`;
      }
      // An alternative npmrc (or pnpm's `--config.<key>`) can set global, prefix or
      // ignore-scripts=false where the per-flag checks above never see it.
      if (/^--(?:userconfig|globalconfig|config\.[\w.-]+)(?:=|$)/.test(w)) {
        return `install points the package manager at another config (an npmrc can make it global or re-enable scripts) — "${shown}"`;
      }
    }
  }
  // The whole command matched an install rule but no segment did (the matcher saw
  // across a quoted separator): it cannot be judged per segment — fail closed.
  if (installSegments === 0)
    return `install form the per-segment check cannot isolate — "${cmd.slice(0, 120)}"`;
  return null;
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

export { bootstrapInstallDir, bootstrapInstallReason };
