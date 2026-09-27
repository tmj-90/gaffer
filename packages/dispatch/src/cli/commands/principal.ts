import type { Command } from "commander";

import { cliActor, open, printJson } from "../shared.js";

/**
 * PER-PRINCIPAL API CREDENTIALS. Named bearer tokens for the REST surface, each
 * bound to an actor identity and a capability tier. `create` prints the token
 * once (only its hash is stored); `list` never shows token material; `revoke`
 * keeps the row for the audit trail.
 */
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
    .action((name: string, opts: { read: boolean; admin: boolean; actorId?: string }, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        const { principal: p, token } = wg.createPrincipal(
          {
            name,
            capability: opts.read ? "read" : "full",
            actorType: opts.admin ? "admin" : "human",
            actorId: opts.actorId,
          },
          cliActor(),
        );
        process.stderr.write(
          `Principal '${p.name}' created (${p.capability}, acts as ${p.actor_type}:${p.actor_id}).\n` +
            "The token below is shown ONCE — store it now; only its hash is kept.\n",
        );
        printJson({ ok: true, principal: p, token });
      } finally {
        wg.db.close();
      }
    });

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
