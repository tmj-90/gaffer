import { spawnSync } from "node:child_process";

import type { Command } from "commander";

import { GIT_REF_SAFE } from "../../domain/schemas.js";
import { cliActor, open, printJson } from "../shared.js";

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

export function registerRepo(program: Command): void {
  const repo = program.command("repo").description("Repository commands");
  repo
    .command("add")
    .description("Register a repository")
    .requiredOption("-n, --name <name>", "repo name")
    .option("--path <path>", "local path")
    .option("--remote <url>", "remote url")
    .option("--branch <branch>", "default branch (auto-detected from --path when omitted)")
    .option("--stack <stack>", "stack")
    .option("--test <cmd>", "test command")
    .option("--lint <cmd>", "lint command (the I3 lint DoD gate)")
    .option("--coverage <cmd>", "coverage command")
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      // When --branch is omitted, detect the repo's ACTUAL default branch from
      // --path rather than assuming `main` — assuming `main` on a `master` repo
      // hard-fails every delivery at `git worktree add … off <default_branch>`.
      const branch = opts.branch ?? detectDefaultBranch(opts.path) ?? "main";
      const r = wg.registerRepository(
        {
          name: opts.name,
          local_path: opts.path,
          remote_url: opts.remote,
          default_branch: branch,
          stack: opts.stack,
          test_command: opts.test,
          lint_command: opts.lint,
          coverage_command: opts.coverage,
        },
        cliActor(),
      );
      printJson({ ok: true, repo: { id: r.id, name: r.name, default_branch: r.default_branch } });
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
    .option("--role <role>", "role", "primary")
    .action((ref, repoName, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const t = wg.resolveTicket(ref);
      wg.linkRepository(t.id, repoName, opts.role, cliActor());
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
    .command("hidden")
    .description("List hidden repositories")
    .action((_opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(wg.listHiddenRepos().map((r) => ({ id: r.id, name: r.name, stack: r.stack })));
      wg.db.close();
    });
}
