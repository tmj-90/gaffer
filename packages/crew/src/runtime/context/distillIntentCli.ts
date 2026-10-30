#!/usr/bin/env node
// =====================================================================
// Node entrypoint for the live ticket → lore distillation at close.
// ---------------------------------------------------------------------
// LIVE: runner/tick.sh gaffer_distill_ticket_intent pipes the closed ticket
// through this CLI. It wraps distillTicketIntent (../../context/ticketIntent.ts),
// the single source of the distillation text, and prints ONLY the requirement
// record (the live close path carries no recorded decisions, so the decision
// draft never applies) as one `{ title, summary }` JSON line — or nothing when
// the ticket has no non-blank acceptance criteria.
//
// CONTRACT (env in, one JSON line or nothing out, always exit 0):
//   SHOW    the `wg ticket show` JSON ({ acceptanceCriteria: [{ text, status }] })
//   DTITLE  the ticket title
//   DREPO   the repo display name
//   DNUM    the ticket number
// Unparseable SHOW prints nothing and exits 0: the distiller is fail-soft and
// must never affect a delivery that is already submitted.
//
// Dependency surface is as tiny as the other runtime CLIs: it imports only the
// pure distiller, so startup stays fast and side-effect-free.
// =====================================================================

import { distillTicketIntent } from "../../context/ticketIntent.js";

function acceptanceCriteria(show: string): Array<{ text: string; status: string }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(show === "" ? "{}" : show);
  } catch {
    return null;
  }
  const raw = (parsed as { acceptanceCriteria?: unknown } | null)?.acceptanceCriteria;
  if (!Array.isArray(raw)) return [];
  return raw.map((a: unknown) => {
    const ac = (a ?? {}) as { text?: unknown; status?: unknown };
    return {
      text: typeof ac.text === "string" ? ac.text : "",
      status: typeof ac.status === "string" ? ac.status : "",
    };
  });
}

function main(): void {
  const env = process.env;
  const acs = acceptanceCriteria(env.SHOW ?? "");
  if (acs === null) return;
  const [requirement] = distillTicketIntent(env.DREPO ?? "", {
    number: env.DNUM ?? "",
    title: env.DTITLE ?? "",
    acceptanceCriteria: acs,
  }).filter((s) => s.kind === "requirement");
  if (!requirement) return;
  process.stdout.write(
    `${JSON.stringify({ title: requirement.title, summary: requirement.summary })}\n`,
  );
}

main();
