import type { Command } from "commander";
import { z } from "zod";

import type { Dispatch } from "../../core.js";
import { DECISION_SEVERITIES } from "../../domain/types.js";
import { resolveDecisionBody } from "../../api/schemas.js";
import { DispatchError } from "../../util/errors.js";
import { cliActor, open, printJson } from "../shared.js";

/** The shortest decision-id prefix `decisions resolve` takes (`gaffer status` shows 8). */
export const MIN_DECISION_PREFIX = 4;

/**
 * A decision by its full id or a unique prefix (≥ {@link MIN_DECISION_PREFIX} chars).
 * Pending decisions are matched first; a prefix that matches no pending decision but
 * exactly one resolved one resolves to it, so resolveDecision reports it as already
 * resolved instead of "not found" (exploratory finding cli-wg/F-19). Too short,
 * ambiguous or unknown → a structured error that says which.
 */
function resolveDecisionRef(wg: Dispatch, ref: string): string {
  const pending = wg.listPendingDecisions();
  if (pending.some((d) => d.id === ref)) return ref;
  if (ref.length < MIN_DECISION_PREFIX) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      `Decision ref "${ref}" is too short: give the full id or a prefix of at least ` +
        `${MIN_DECISION_PREFIX} characters (\`gaffer status\` shows the first 8).`,
      { ref, min_length: MIN_DECISION_PREFIX },
    );
  }
  const hits = pending.filter((d) => d.id.startsWith(ref));
  if (hits.length === 1) return hits[0]!.id;
  if (hits.length > 1) {
    throw new DispatchError(
      "AMBIGUOUS_REF",
      `Decision ref "${ref}" matches ${hits.length} pending decisions.`,
      {
        ref,
        matches: hits.map((d) => d.id),
      },
    );
  }
  // Not pending: a unique prefix of a resolved decision resolves to it, so
  // resolveDecision reports STATE_CONFLICT ("already 'accepted'"), else NOT_FOUND.
  const all = wg.decisions.idsWithPrefix(ref);
  return all.length === 1 ? all[0]! : ref;
}

export function registerDecisions(program: Command): void {
  const decisions = program.command("decisions").description("Decision commands");
  decisions
    .command("list")
    .description("List pending decisions")
    .action((_opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(wg.listPendingDecisions());
      wg.db.close();
    });

  // The terminal-only way to answer a decision (the dashboard and REST POST
  // /decisions/:id/resolve were the only ones, so `gaffer status` listed items a CLI
  // user could never clear). Validated by the SAME schema as the REST route. Human
  // actor, like `review approve`; deliberately NOT exposed over MCP, so an agent
  // cannot answer its own escalation.
  decisions
    .command("resolve <id>")
    .description(
      "Answer a pending decision: its full id, or a unique prefix of at least " +
        `${MIN_DECISION_PREFIX} characters (\`gaffer status\` shows the first 8)`,
    )
    .option("--answer <text>", "the answer the agent will read")
    .option("--status <status>", "accepted | rejected", "accepted")
    .option("--rationale <text>", "why (recorded with the answer)")
    .action((id: string, opts, cmd) => {
      const body = resolveDecisionBody.parse({
        status: opts.status,
        ...(opts.answer !== undefined ? { answer: opts.answer } : {}),
        ...(opts.rationale !== undefined ? { rationale: opts.rationale } : {}),
      });
      const wg = open(cmd.optsWithGlobals());
      try {
        const decision = wg.resolveDecision(
          {
            decisionId: resolveDecisionRef(wg, id),
            status: body.status,
            answer: body.answer,
            rationale: body.rationale,
          },
          cliActor(),
        );
        printJson({ ok: true, decision: { id: decision.id, status: decision.status } });
      } finally {
        wg.db.close();
      }
    });

  program
    .command("decision")
    .description("Create a decision/blocker")
    .requiredOption("--title <title>", "title")
    .requiredOption("--question <q>", "question")
    .option("--severity <sev>", "severity", "human_preferred")
    .option(
      "--ticket <ref>",
      "block this ticket (repeat to hold several on one decision)",
      (ref: string, prev: string[]) => [...prev, ref],
      [] as string[],
    )
    .action((opts, cmd) => {
      const severityResult = z.enum(DECISION_SEVERITIES).safeParse(opts.severity);
      if (!severityResult.success) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          `Invalid severity: "${opts.severity}". Allowed: ${DECISION_SEVERITIES.join(", ")}.`,
          { severity: opts.severity, allowed: DECISION_SEVERITIES },
        );
      }
      const wg = open(cmd.optsWithGlobals());
      const refs = (opts.ticket as string[]).map((ref) => wg.resolveTicket(ref).id);
      const d = wg.createDecision(
        {
          title: opts.title,
          question: opts.question,
          severity: severityResult.data,
          ...(refs.length ? { ticketIds: refs } : {}),
        },
        cliActor(),
      );
      printJson({ ok: true, decision: { id: d.id, status: d.status } });
      wg.db.close();
    });
}
