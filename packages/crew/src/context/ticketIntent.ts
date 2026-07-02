import type { LoreSuggestionInput } from "../memory/client.js";

/**
 * Ticket → lore distillation at close (Track 1c).
 *
 * A ticket's title, acceptance criteria, decisions and reject-reasons carry the
 * REAL product intent — WHY this work exists and WHY it was built the way it
 * was. At close that intent evaporates: the ticket is marked done and nothing
 * durable captures it. This module distills that intent into DRAFT lore so the
 * "why" survives the ticket. It NEVER auto-promotes — the drafts are flushed via
 * the Memory `suggest_lore` boundary and a human ratifies them.
 *
 * The distillation is deliberately conservative: if a ticket carries neither
 * acceptance criteria nor decisions there is nothing durable to harvest, so it
 * returns `[]` rather than drafting noise.
 */

/** The ticket signals a distillation is built from. */
export interface TicketIntentSource {
  number: number;
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
  const acLines = src.acceptanceCriteria.map((ac) => `- ${ac.text}`);
  const hasAc = acLines.length > 0;
  const hasDecisions = (src.decisions?.length ?? 0) > 0 || (src.rejectReasons?.length ?? 0) > 0;
  if (!hasAc && !hasDecisions) return [];

  const suggestions: LoreSuggestionInput[] = [];

  if (hasAc) {
    suggestions.push({
      title: `Requirement from #${src.number}: ${src.title}`.slice(0, MAX_TITLE),
      summary: clampSummary(
        `Why '${repoName}' ticket #${src.number} ("${src.title}") was built — the requirement it ` +
          `served (distilled at close for ratification; not auto-promoted):\n${acLines.join("\n")}` +
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
          `(distilled at close; not auto-promoted):\n${parts.join("\n\n")}`,
      ),
      tags: ["ticket-intent", "decision", `ticket-${src.number}`],
      kind: "decision",
    });
  }

  return suggestions;
}
