import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { Command } from "commander";

import { GIT_REF_SAFE } from "../../domain/schemas.js";
import { TICKET_REPO_ROLES } from "../../domain/types.js";
import { DispatchError } from "../../util/errors.js";
import {
  AS_HUMAN_OR_SYSTEM_HELP,
  cliActor,
  humanOrSystemActor,
  open,
  parseOneOf,
  printJson,
} from "../shared.js";

/**
 * Best-effort detection of a local repo's default branch, so `repo add` no longer
 * blindly assumes `main` (which hard-fails delivery on a `master` repo at worktree
 * setup). Prefers the remote's default (`origin/HEAD` → what a clone checks out),
 * then the locally checked-out branch. Returns a GIT_REF_SAFE branch name or
 * undefined when the path is absent / not a git repo / detection fails — the
 * caller then falls back to "main". Never throws.
 */
export function detectDefaultBranch(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const git = (args: string[]): string | undefined => {
    try {
      const r = spawnSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 5_000 });
      if (r.status !== 0) return undefined;
      const out = (r.stdout || "").trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  };
  // `origin/HEAD` → `origin/<branch>`; strip the remote prefix to the bare branch.
  const remoteHead = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const remoteBranch = remoteHead?.replace(/^origin\//, "");
  const candidate = remoteBranch || git(["symbolic-ref", "--short", "HEAD"]);
  return candidate && GIT_REF_SAFE.test(candidate) ? candidate : undefined;
}

/**
 * `repo add --path` the way `gaffer onboard` takes a path (exploratory finding
 * cli-wg/F-06): resolved against the cwd and canonicalised (`cd "$path" && pwd -P`),
 * so the stored path never depends on where the dashboard or runner was started; a
 * missing path or a file is refused; a directory that is not a git repo is kept, with
 * the onboard warning (the factory branches per ticket).
 */
export function canonicalRepoPath(path: string): {
  path: string;
  warnings: { code: string; message: string }[];
} {
  let abs: string;
  try {
    abs = realpathSync(resolve(path));
  } catch {
    throw new DispatchError("VALIDATION_ERROR", `--path: no such directory: ${path}`, { path });
  }
  if (!statSync(abs).isDirectory()) {
    throw new DispatchError("VALIDATION_ERROR", `--path is not a directory: ${path}`, { path });
  }
  const git = spawnSync("git", ["-C", abs, "rev-parse", "--git-dir"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const warnings =
    git.status === 0
      ? []
      : [
          {
            code: "NOT_A_GIT_REPO",
            message: `${abs} is not a git repo (the factory branches per ticket — you'll want one); the default branch falls back to main.`,
          },
        ];
  return { path: abs, warnings };
}

export function registerRepo(program: Command): void {
  const repo = program.command("repo").description("Repository commands");
  repo
    .command("add")
    .description("Register a repository")
    .requiredOption("-n, --name <name>", "repo name")
    .option("--path <path>", "local checkout (must exist; stored as its canonical absolute path)")
    .option("--remote <url>", "remote url")
    .option("--branch <branch>", "default branch (auto-detected from --path when omitted)")
    .option("--stack <stack>", "stack")
    .option("--test <cmd>", "test command")
    .option("--lint <cmd>", "lint command (the I3 lint DoD gate)")
    .option("--coverage <cmd>", "coverage command")
    .action((opts, cmd) => {
      const checked =
        opts.path !== undefined
          ? canonicalRepoPath(String(opts.path))
          : { path: undefined, warnings: [] };
      const wg = open(cmd.optsWithGlobals());
      // When --branch is omitted, detect the repo's ACTUAL default branch from
      // --path rather than assuming `main` — assuming `main` on a `master` repo
      // hard-fails every delivery at `git worktree add … off <default_branch>`.
      const branch = opts.branch ?? detectDefaultBranch(checked.path) ?? "main";
      const r = wg.registerRepository(
        {
          name: opts.name,
          local_path: checked.path,
          remote_url: opts.remote,
          default_branch: branch,
          stack: opts.stack,
          test_command: opts.test,
          lint_command: opts.lint,
          coverage_command: opts.coverage,
        },
        cliActor(),
      );
      for (const w of checked.warnings) process.stderr.write(`warning: ${w.code}: ${w.message}\n`);
      printJson({
        ok: true,
        repo: {
          id: r.id,
          name: r.name,
          default_branch: r.default_branch,
          local_path: r.local_path,
        },
        ...(checked.warnings.length > 0 ? { warnings: checked.warnings } : {}),
      });
      wg.db.close();
    });

  repo
    .command("set-commands <name>")
    .description(
      "Set a repo's test / lint Definition-of-Done gate commands and its coverage command (omitted = unchanged; pass '' to clear one)",
    )
    .option("--test <cmd>", "test command (the DoD tests gate)")
    .option("--lint <cmd>", "lint command (the DoD lint gate)")
    .option(
      "--coverage <cmd>",
      "coverage command (feeds the idle coverage scan; NOT a DoD gate — coverage-did-not-decrease is deferred)",
    )
    .action((name, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const r = wg.setRepoCommands(
        name,
        {
          ...(opts.test !== undefined ? { test_command: opts.test } : {}),
          ...(opts.lint !== undefined ? { lint_command: opts.lint } : {}),
          ...(opts.coverage !== undefined ? { coverage_command: opts.coverage } : {}),
        },
        cliActor(),
      );
      printJson({
        ok: true,
        repo: {
          id: r.id,
          name: r.name,
          test_command: r.test_command,
          lint_command: r.lint_command,
          coverage_command: r.coverage_command,
        },
      });
      wg.db.close();
    });

  repo
    .command("set-branch <name> <branch>")
    .description("Set a repo's default branch (the base every delivery worktree branches off)")
    .action((name, branch, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const r = wg.setRepoDefaultBranch(name, branch, cliActor());
      printJson({ ok: true, repo: { id: r.id, name: r.name, default_branch: r.default_branch } });
      wg.db.close();
    });

  repo
    .command("link <ref> <repoName>")
    .description("Link a repository to a ticket")
    .option(
      "--role <role>",
      `the repo's role on the ticket: ${TICKET_REPO_ROLES.join(" | ")}`,
      "primary",
    )
    .option("--as <type>", AS_HUMAN_OR_SYSTEM_HELP, "human")
    .action((ref, repoName, opts, cmd) => {
      const actor = humanOrSystemActor(opts.as);
      // cli-wg/F-07: refused here, naming the roles, not by the DB's CHECK constraint.
      const role = parseOneOf("--role", opts.role, TICKET_REPO_ROLES);
      const wg = open(cmd.optsWithGlobals());
      const t = wg.resolveTicket(ref);
      wg.linkRepository(t.id, repoName, role, actor);
      printJson({ ok: true });
      wg.db.close();
    });

  repo
    .command("hide <name>")
    .description("Hide a repo from the dashboard (stays registered; reversible)")
    .action((name, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const r = wg.setRepoHidden(name, true, cliActor());
      printJson({ ok: true, repo: { id: r.id, name: r.name, hidden: r.hidden } });
      wg.db.close();
    });

  repo
    .command("unhide <name>")
    .description("Un-hide a previously hidden repo (returns it to its normal place)")
    .action((name, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const r = wg.setRepoHidden(name, false, cliActor());
      printJson({ ok: true, repo: { id: r.id, name: r.name, hidden: r.hidden } });
      wg.db.close();
    });

  repo
    .command("list")
    .description("List registered repositories (name, path, default branch, stack, DoD gates)")
    .option("--all", "include hidden repositories", false)
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(
        wg.listRepositories(Boolean(opts.all)).map((r) => ({
          id: r.id,
          name: r.name,
          local_path: r.local_path,
          default_branch: r.default_branch,
          stack: r.stack,
          risk_level: r.risk_level,
          test_command: r.test_command,
          lint_command: r.lint_command,
          hidden: r.hidden === 1,
        })),
      );
      wg.db.close();
    });
  repo
    .command("hidden")
    .description("List hidden repositories")
    .action((_opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(wg.listHiddenRepos().map((r) => ({ id: r.id, name: r.name, stack: r.stack })));
      wg.db.close();
    });
}
