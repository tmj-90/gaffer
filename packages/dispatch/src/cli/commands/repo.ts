import type { Command } from "commander";

import { cliActor, open, printJson } from "../shared.js";

export function registerRepo(program: Command): void {
  const repo = program.command("repo").description("Repository commands");
  repo
    .command("add")
    .description("Register a repository")
    .requiredOption("-n, --name <name>", "repo name")
    .option("--path <path>", "local path")
    .option("--remote <url>", "remote url")
    .option("--branch <branch>", "default branch", "main")
    .option("--stack <stack>", "stack")
    .option("--test <cmd>", "test command")
    .option("--lint <cmd>", "lint command (the I3 lint DoD gate)")
    .option("--coverage <cmd>", "coverage command")
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const r = wg.registerRepository(
        {
          name: opts.name,
          local_path: opts.path,
          remote_url: opts.remote,
          default_branch: opts.branch,
          stack: opts.stack,
          test_command: opts.test,
          lint_command: opts.lint,
          coverage_command: opts.coverage,
        },
        cliActor(),
      );
      printJson({ ok: true, repo: { id: r.id, name: r.name } });
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
