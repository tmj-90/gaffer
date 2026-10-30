import type { LoreSuggestionInput } from "../memory/client.js";

/**
 * Ticket → lore distillation at close (Track 1c).
 *
 * A ticket's title, acceptance criteria, decisions and reject-reasons carry the
 * REAL product intent — WHY this work exists and WHY it was built the way it
 * was. At close that intent evaporates: the ticket is marked done and nothing
 * durable captures it. This module distills that intent into DRAFT lore so the
 * "why" survives the ticket. This module only DISTILLS; promotion is the
 * caller's policy: crew's mock loop flushes the drafts through the Memory
 * `suggest_lore` boundary for a human to ratify, while the live runner (tick.sh
 * gaffer_distill_ticket_intent, via runtime/context/distillIntentCli.ts) drafts
 * them and auto-promotes only under MEMORY_AUTO_APPROVE / GAFFER_MEMORY_AUTO_PROMOTE.
 *
 * This is the SINGLE source of the live distillation text (the former JS twin in
 * runner/lib/json-tool.mjs was removed); runner/test/distill-intent-golden.test.sh
 * pins its output.
 *
 * The distillation is deliberately conservative: if a ticket carries neither
 * acceptance criteria (with any non-blank text) nor decisions there is nothing
 * durable to harvest, so it returns `[]` rather than drafting noise.
 */

/** The ticket signals a distillation is built from. */
export interface TicketIntentSource {
  /** Rendered verbatim (the live CLI passes the runner's string ticket number). */
  number: number | string;
  title: string;
  description?: string;
  acceptanceCriteria: ReadonlyArray<{ text: string; status: string }>;
  /** Decisions recorded on the ticket (choices made), when the caller has them. */
  decisions?: ReadonlyArray<string>;
  /** Reasons a review/decision was rejected — a strong "why NOT" intent signal. */
  rejectReasons?: ReadonlyArray<string>;
  /** One-line summary of what the agent actually did, when available. */
  outcomeSummary?: string;
}

/** Memory caps summaries at 800 chars; stay comfortably under it. */
const MAX_SUMMARY = 780;
/** Memory caps titles at 200 chars. */
const MAX_TITLE = 190;

function clampSummary(text: string): string {
  return text.length <= MAX_SUMMARY ? text : text.slice(0, MAX_SUMMARY - 1) + "…";
}

/**
 * Distill a closed ticket's product intent into DRAFT lore suggestions. Produces
 * up to two records:
 *   - a REQUIREMENT draft (kind: 'requirement') — the product need the ticket
 *     served, distilled from its title + acceptance criteria;
 *   - a DECISION draft (kind: 'decision') — the choices + rejected alternatives /
 *     constraints behind HOW it was built, distilled from its decisions +
 *     reject-reasons.
 *
 * Both are drafts (human-gated). Returns `[]` when neither AC nor decisions are
 * present — there is no durable intent to harvest.
 */
export function distillTicketIntent(
  repoName: string,
  src: TicketIntentSource,
): LoreSuggestionInput[] {
  // Blank / whitespace-only criteria carry no intent: drop them, so a ticket with
  // only empty ACs drafts nothing instead of a body of bare "- " lines.
  const acLines = src.acceptanceCriteria
    .map((ac) => (ac.text ?? "").trim())
    .filter((text) => text.length > 0)
    .map((text) => `- ${text}`);
  const hasAc = acLines.length > 0;
  const hasDecisions = (src.decisions?.length ?? 0) > 0 || (src.rejectReasons?.length ?? 0) > 0;
  if (!hasAc && !hasDecisions) return [];

  const suggestions: LoreSuggestionInput[] = [];

  if (hasAc) {
    suggestions.push({
      title: `Requirement from #${src.number}: ${src.title}`.slice(0, MAX_TITLE),
      summary: clampSummary(
        `Why '${repoName}' ticket #${src.number} ("${src.title}") was built — the requirement it ` +
          `served (distilled at close from the delivered work):\n${acLines.join("\n")}` +
          (src.outcomeSummary ? `\n\nOutcome: ${src.outcomeSummary}` : ""),
      ),
      tags: ["ticket-intent", "requirement", `ticket-${src.number}`],
      kind: "requirement",
    });
  }

  if (hasDecisions) {
    const parts: string[] = [];
    if (src.decisions?.length) {
      parts.push("Decisions:\n" + src.decisions.map((d) => `- ${d}`).join("\n"));
    }
    if (src.rejectReasons?.length) {
      parts.push("Rejected / constraints:\n" + src.rejectReasons.map((r) => `- ${r}`).join("\n"));
    }
    suggestions.push({
      title: `Decision from #${src.number}: ${src.title}`.slice(0, MAX_TITLE),
      summary: clampSummary(
        `Why '${repoName}' ticket #${src.number} ("${src.title}") was built THIS way ` +
          `(distilled at close):\n${parts.join("\n\n")}`,
      ),
      tags: ["ticket-intent", "decision", `ticket-${src.number}`],
      kind: "decision",
    });
  }

  return suggestions;
}
