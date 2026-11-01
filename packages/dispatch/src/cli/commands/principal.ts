import type { Command } from "commander";

import { DispatchError } from "../../util/errors.js";
import { cliActor, open, printJson } from "../shared.js";

/**
 * PER-PRINCIPAL API CREDENTIALS. Named bearer tokens for the REST surface, each
 * bound to an actor identity and a capability tier. `create` prints the token
 * once (only its hash is stored); `list` never shows token material; `revoke`
 * keeps the row for the audit trail.
 */
/** Commander collector for a repeatable option. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerPrincipal(program: Command): void {
  const principal = program
    .command("principal")
    .description(
      "Named API credentials: `create` mints a token bound to an actor identity (shown once), " +
        "`list` shows every principal, `revoke` disables one.",
    );

  principal
    .command("create <name>")
    .description("Mint a bearer token for a named principal (printed once)")
    .option("--read", "read-scoped: GET routes only", false)
    .option("--admin", "act as an admin actor instead of a human", false)
    .option(
      "--actor-id <id>",
      "the actor id recorded on this principal's writes (default: the name)",
    )
    .option(
      "--repo <name>",
      "scope it to a repository (repeatable): it reaches only tickets whose write repos all sit inside its repos",
      collect,
      [] as string[],
    )
    .option(
      "--ticket <n>",
      "scope it to a ticket (repeatable): it reaches these tickets whatever their repos",
      collect,
      [] as string[],
    )
    .action(
      (
        name: string,
        opts: {
          read: boolean;
          admin: boolean;
          actorId?: string;
          repo: string[];
          ticket: string[];
        },
        cmd,
      ) => {
        if (opts.read && opts.admin) {
          // cli-wg/F-20: a read-scoped admin is a contradiction (it used to be minted).
          throw new DispatchError(
            "VALIDATION_ERROR",
            "--read and --admin conflict: a read-only principal cannot act as an admin.",
          );
        }
        const wg = open(cmd.optsWithGlobals());
        try {
          const { principal: p, token } = wg.createPrincipal(
            {
              name,
              capability: opts.read ? "read" : "full",
              actorType: opts.admin ? "admin" : "human",
              actorId: opts.actorId,
              repos: opts.repo.length > 0 ? opts.repo : undefined,
              tickets: opts.ticket.length > 0 ? opts.ticket : undefined,
            },
            cliActor(),
          );
          const scope = p.scope
            ? `, scoped to ${[
                p.scope.repos ? `repos ${p.scope.repos.map((r) => r.name).join(", ")}` : "",
                p.scope.tickets
                  ? `tickets ${p.scope.tickets.map((t) => `#${t.number}`).join(", ")}`
                  : "",
              ]
                .filter((x) => x !== "")
                .join(" and ")}`
            : "";
          process.stderr.write(
            `Principal '${p.name}' created (${p.capability}, acts as ${p.actor_type}:${p.actor_id}${scope}).\n` +
              "The token below is shown ONCE — store it now; only its hash is kept.\n",
          );
          printJson({ ok: true, principal: p, token });
        } finally {
          wg.db.close();
        }
      },
    );

  principal
    .command("list")
    .description("List every principal (revoked ones included); never shows token material")
    .action((_opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        printJson({ ok: true, principals: wg.listPrincipals() });
      } finally {
        wg.db.close();
      }
    });

  principal
    .command("revoke <id-or-name>")
    .description("Revoke a principal's token (the row stays for the audit trail)")
    .action((ref: string, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        printJson({ ok: true, principal: wg.revokePrincipal(ref, cliActor()) });
      } finally {
        wg.db.close();
      }
    });
}
