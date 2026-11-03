import { CrewError } from "../../util/errors.js";

import { renderScoutBlock, type PromptScout } from "./deliveryPrompt.js";
import { QUARANTINE_NOTICE, quarantine } from "./quarantine.js";

// =====================================================================
// The bounded MODEL SCOUT's prompt (delta roadmap gap 3, gap-verify B2). LIVE: the
// runner (lib/scout.sh gaffer_model_scout) renders it through renderPromptCli.js
// (kind "scout") for a medium-or-higher ticket when the runner's scout knob asks for it, then
// spawns ONE read-only call (Read, Grep, Glob; no MCP; a few turns). The reply is a
// JSON object the runner validates against the checkout (lib/scout.mjs mergeModel).
// Not a planning ceremony: at most 8 files, 8 symbols, 10 notes, 3 questions.
// =====================================================================

export interface ScoutPromptInputs {
  ticketNumber: string;
  title: string;
  /** The ticket description (untrusted; quarantined here). */
  description: string;
  /** The real repo, read-only. */
  repoPath: string;
  /** The ticket's effective risk level after the classifier. */
  risk: string;
  /** The deterministic packet (already normalised), or null. */
  scout: PromptScout | null;
}

export function renderScoutPrompt(i: ScoutPromptInputs): string {
  for (const [v, f] of [
    [i.ticketNumber, "ticketNumber"],
    [i.title, "title"],
    [i.repoPath, "repoPath"],
  ] as const)
    if (v === "")
      throw new CrewError("INVALID_PROMPT_INPUTS", `scout prompt requires a non-empty ${f}`, {
        field: f,
      });
  const titleQ = quarantine("ticket-title", i.title, "single");
  const descQ = quarantine("ticket-description", i.description.slice(0, 4000));
  const found = renderScoutBlock(i.scout ? { ...i.scout, model: null, risk: null } : null);
  return `You are a read-only SCOUT for ticket #${i.ticketNumber}. You change nothing: you have the
Read, Grep and Glob tools only, and a few turns. Your job is to say where this change most
likely lands, so the delivery agent that runs after you does not wander.
${QUARANTINE_NOTICE}
Ticket #${i.ticketNumber} (risk ${i.risk}), title: ${titleQ}
Description:
${descQ}
The repository (read-only) is at: ${i.repoPath}
${found}
Read only what you need to confirm the likely files. Then reply with ONE JSON object and
nothing else:
{"files":[{"path":"<path relative to the repository root>","why":"<one line>"}],
 "symbols":[{"name":"<identifier>","path":"<the file that declares it>"}],
 "notes":["<a short line: what to change, and which test proves it>"],
 "questions":["<only a question whose answer changes what gets built>"]}
At most 8 files, 8 symbols, 10 notes and 3 questions. Every path must exist in the
repository: the runner drops any that does not, and any symbol its file does not contain.
Do not write a plan document, do not restate the ticket, and do not edit anything.`;
}
