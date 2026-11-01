import type { Command } from "commander";

import type { Dispatch } from "../core.js";
import type { PrincipalView } from "../repositories/principalRepository.js";
import type { AccessAction } from "../services/accessScope.js";
import { DispatchError } from "../util/errors.js";

/**
 * CLI IDENTITY. Without a token the CLI is the operator: whoever can open the
 * database file can change anything in it, so `$USER` is recorded as the actor and
 * nothing is checked (`wg whoami` says plainly that this identity is asserted, not
 * authenticated). With `GAFFER_PRINCIPAL_TOKEN` (or `--as-principal <token>`) it acts
 * as that principal: resolved from the same table the API authenticates against,
 * every write recorded under the principal's actor, and the principal's read-only
 * flag, admin flag and repo/ticket scope enforced through the same evaluation REST
 * uses (services/accessScope.ts, by way of {@link Dispatch.assertPrincipalAccess}).
 *
 * Each command maps to one action below; a command missing from the table is a
 * factory-wide write (fail closed: a scoped or read-only principal is refused).
 */

/** How a command's target is found. `arg0`/`arg1`: that positional argument. */
type Rule =
  | { kind: "read_ticket" | "write_ticket"; ticketArg?: 0 | 1; alsoRead?: 1 }
  | { kind: "repo_link"; repoArg?: 1 }
  | { kind: "write_repo"; repoArg?: 0 }
  | { kind: "decision" }
  | { kind: "decision_create" }
  | { kind: "create_ticket" }
  | { kind: "scope_link" }
  | { kind: "machine" }
  | { kind: "list_tickets" }
  | { kind: "read_factory" }
  | { kind: "write_factory" }
  | { kind: "open" }
  | { kind: "whoami" }
  | { kind: "operator_only" };

const READ_TICKET: Rule = { kind: "read_ticket" };
const WRITE_TICKET: Rule = { kind: "write_ticket" };
const READ_FACTORY: Rule = { kind: "read_factory" };

/** Command path (`ticket repo-access set`) → its rule. */
const RULES: Record<string, Rule> = {
  // `whoami --can-write <ref>` asks the write question without writing (gaffer merge).
  whoami: { kind: "whoami" },
  "ticket create": { kind: "create_ticket" },
  "ticket list": { kind: "list_tickets" },
  ...Object.fromEntries(
    [
      "ticket show",
      "ticket diff",
      "ticket landing",
      "ticket dossier",
      "ticket ci-status",
      "ticket scope list",
      "ticket dep list",
      "ticket repo-access packet",
      "ticket repo-delivery list",
      "ticket paused-context",
    ].map((c) => [c, READ_TICKET]),
  ),
  ...Object.fromEntries(
    [
      "ticket edit",
      "ticket budget",
      "ticket ready",
      "ticket move",
      "ticket landing-begin",
      "ticket record-landing",
      "ticket auto-decision",
      "ticket approve-ready",
      "ticket set-reviewer",
      "ticket reopen-for-review",
      "ticket hold",
      "ticket ci-result",
      "ticket mark-merged",
      "ticket set-testable",
      "ticket allow-test-changes",
      "ticket test-contract",
      "ticket tester-pass",
      "ticket tester-fail",
      "ticket require-cap",
      "ticket repo-delivery record",
      "ticket continue",
      "ticket stop",
      "ticket paused-clear",
      "ac add",
      "ac edit",
      "ac rm",
      "human-claim",
      "human-release",
      "delivery-artifact",
      "block",
      "unblock",
      "review approve",
      "review reject",
      "wont-do",
      "reopen",
    ].map((c) => [c, WRITE_TICKET]),
  ),
  // Runner and agent bookkeeping: recorded as the system or as an agent (a claim, its
  // evidence and submission, the runner's release, rework, pause and resume, the AC
  // check results, delivery evidence without a claim). A principal acts only as itself,
  // so no principal runs these; the factory's own calls carry no principal token.
  ...Object.fromEntries(
    [
      "claim",
      "claim-ticket",
      "evidence",
      "submit",
      "runner-release",
      "runner-rework",
      "attach-evidence",
      "expire-claims",
      "ticket pause",
      "ticket resume-begin",
      "ticket record-tester-replay",
      "ac check-result",
      "ticket repo-access inherit",
    ].map((c) => [c, { kind: "machine" } as Rule]),
  ),
  // A ticket's place on the map and in an epic: joining or leaving an epic rewires its
  // acceptance ticket (another ticket), so a scoped principal may not (the API's rule).
  "ticket scope link": { kind: "scope_link" },
  "ticket scope primary": { kind: "scope_link" },
  "ticket scope rm": { kind: "scope_link" },
  // A dependency is a write to the first ticket that names the second.
  "ticket dep add": { kind: "write_ticket", alsoRead: 1 },
  "ticket dep rm": { kind: "write_ticket", alsoRead: 1 },
  // A ticket's repositories: a write to the ticket AND a repo-level write (admin).
  "ticket repo-access set": { kind: "repo_link", repoArg: 1 },
  "ticket repo-access mono-fallback": { kind: "repo_link" },
  "repo link": { kind: "repo_link", repoArg: 1 },
  "repo set-commands": { kind: "write_repo", repoArg: 0 },
  "repo set-branch": { kind: "write_repo", repoArg: 0 },
  "repo hide": { kind: "write_repo", repoArg: 0 },
  "repo unhide": { kind: "write_repo", repoArg: 0 },
  "repo add": { kind: "write_repo" },
  "decisions resolve": { kind: "decision" },
  decision: { kind: "decision_create" },
  // A principal never mints or revokes principals (the REST rule: the operator only).
  "principal create": { kind: "operator_only" },
  "principal revoke": { kind: "operator_only" },
  ...Object.fromEntries(
    [
      "repo list",
      "repo hidden",
      "spec get",
      "spec coverage",
      "spec list",
      "scope node list",
      "scope node show",
      "scope edge list",
      "scope repo list",
      "scope unmapped",
      "decisions list",
      "agent list",
      "doctor",
      "events list",
      "events verify",
      "stats",
      "human-queue",
      "export",
      "principal list",
      "autonomy list",
      "autonomy policies",
      "club show",
      "ticket resume-requested",
    ].map((c) => [c, READ_FACTORY]),
  ),
};

/** `ticket repo-access set` for the leaf command. */
export function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c && c.parent; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/**
 * Refuse a command a principal may not run. `args` are the leaf command's
 * positional arguments, `opts` its options.
 */
export function assertPrincipalCommand(
  wg: Dispatch,
  principal: PrincipalView,
  path: string,
  args: readonly unknown[],
  opts: Record<string, unknown>,
): void {
  const rule: Rule = RULES[path] ?? { kind: "write_factory" };
  const check = (action: AccessAction): void => wg.assertPrincipalAccess(principal, action);
  const arg = (i: number): string => String(args[i] ?? "");
  const repoId = (ref: string): string =>
    (wg.repos.findById(ref) ?? wg.repos.findByName(ref))?.id ?? ref;
  if (rule.kind === "machine" || (path === "block" && typeof opts.token === "string")) {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      `Acting as principal '${principal.name}', every write is recorded as ${principal.actor_type}:${principal.actor_id}; '${path}' records the runner (system) or an agent, so a principal does not run it.`,
      { principal: principal.name, command: path },
    );
  }
  if (rule.kind === "operator_only") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only the operator (the CLI without a principal token, or the shared API token) may create or revoke principals.",
      { principal: principal.name },
    );
  }
  assertOwnIdentity(principal, opts);
  switch (rule.kind) {
    case "open":
    case "list_tickets": // filtered by the command itself (cliTicketFilter)
      return;
    case "whoami":
      if (typeof opts.canWrite === "string") {
        check({ kind: "write_ticket", ticket: wg.scopeTicket(opts.canWrite) });
      }
      return;
    case "read_ticket":
    case "write_ticket":
      check({ kind: rule.kind, ticket: wg.scopeTicket(arg(rule.ticketArg ?? 0)) });
      if (rule.alsoRead !== undefined) {
        check({ kind: "read_ticket", ticket: wg.scopeTicket(arg(rule.alsoRead)) });
      }
      return;
    case "repo_link": {
      const ticket = wg.scopeTicket(arg(0));
      check({ kind: "write_ticket", ticket });
      check({
        kind: "write_repo",
        repos: rule.repoArg !== undefined ? [repoId(arg(rule.repoArg))] : ticket.repos,
      });
      return;
    }
    case "write_repo":
      check({
        kind: "write_repo",
        repos: rule.repoArg !== undefined ? [repoId(arg(0))] : undefined,
      });
      return;
    case "decision": {
      const ids = wg.decisionTicketIds(arg(0));
      if (ids.length === 0) return check({ kind: "write_factory" });
      for (const id of ids) check({ kind: "write_ticket", ticket: wg.scopeTicket(id) });
      return;
    }
    case "decision_create": {
      const t = typeof opts.ticket === "string" ? opts.ticket : undefined;
      if (t) return check({ kind: "write_ticket", ticket: wg.scopeTicket(t) });
      return check({ kind: "write_factory" });
    }
    case "create_ticket":
      // `ticket create` names no repository: a repo-scoped principal links one through
      // the API's create (`repoIds`), which checks it; here it is refused unless unscoped.
      return check({ kind: "create_ticket", repos: [] });
    case "scope_link":
      check({ kind: "write_ticket", ticket: wg.scopeTicket(arg(0)) });
      return check({ kind: "write_factory" });
    case "read_factory":
      return check({ kind: "read_factory" });
    case "write_factory":
      return check({ kind: "write_factory" });
  }
}

/**
 * Acting as a principal, the identity is the principal's: an option that would record
 * someone or something else (`--as system|agent`, `--as admin` for a human principal,
 * `--admin`, `--reviewer <someone else>`) is refused rather than silently ignored.
 */
function assertOwnIdentity(principal: PrincipalView, opts: Record<string, unknown>): void {
  const refuse = (what: string): never => {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      `Acting as principal '${principal.name}', every write is recorded as ${principal.actor_type}:${principal.actor_id}; ${what} would record another identity.`,
      { principal: principal.name },
    );
  };
  const as = opts.as;
  if (typeof as === "string") {
    if (as === "system" || as === "agent") refuse(`--as ${as}`);
    if (as === "admin" && principal.actor_type !== "admin") refuse("--as admin");
  }
  if (opts.admin === true && principal.actor_type !== "admin") refuse("--admin");
  if (typeof opts.reviewer === "string" && opts.reviewer !== principal.actor_id) {
    refuse(`--reviewer ${opts.reviewer}`);
  }
}
