/**
 * PLANNING CLARIFICATIONS → the epic's acceptance contract.
 *
 * During "Plan a build" the planner asks clarifying questions and the human answers
 * them. Those answers are REQUIREMENTS the human stated ("links expire after 30
 * minutes"). The planner's proposed tickets may leave one out, and confirmation used
 * to keep only the opening brief, so the acceptance contract had no such criterion and
 * the independent tester never heard of it. These helpers pull the agreed requirements
 * out of a plan session's recorded turns, and tell the confirmation step which of them
 * no proposed criterion covers. Pure; no I/O.
 */

/** One requirement the human agreed during clarification. */
export interface AgreedRequirement {
  /** The planner's question(s) the answer replied to (joined), when known. */
  question?: string | undefined;
  /** The human's answer, verbatim (trimmed). */
  answer: string;
}

/** The minimal turn shape (a persisted PlanMessage, or the dashboard's history). */
export interface ClarificationTurn {
  role: "user" | "assistant";
  content: string;
}

/** The questions an assistant turn asked, from its `{ phase: "clarify", questions }` envelope. */
function clarifyQuestions(content: string): string[] | null {
  try {
    const env = JSON.parse(content) as { phase?: unknown; questions?: unknown };
    if (env && env.phase === "clarify" && Array.isArray(env.questions)) {
      return env.questions.filter((q): q is string => typeof q === "string" && q.trim() !== "");
    }
  } catch {
    /* not an envelope */
  }
  return null;
}

/**
 * The requirements agreed in a plan session: every user turn that ANSWERS a clarify
 * turn (the opening brief is the brief, not an answer). Bounded: at most 50, each
 * answer ≤ 4000 characters (the epic input's limits).
 */
export function agreedRequirementsFromTurns(
  turns: readonly ClarificationTurn[],
): AgreedRequirement[] {
  const out: AgreedRequirement[] = [];
  let pending: string[] | null = null;
  for (const t of turns) {
    if (t.role === "assistant") {
      pending = clarifyQuestions(t.content);
      continue;
    }
    const answer = String(t.content ?? "").trim();
    if (pending !== null && answer !== "") {
      out.push({
        ...(pending.length ? { question: pending.join(" ").slice(0, 4000) } : {}),
        answer: answer.slice(0, 4000),
      });
    }
    pending = null;
  }
  return out.slice(0, 50);
}

const STOPWORDS = new Set(
  (
    "the a an and or but of to in on at for with from by as is are be been it its this that " +
    "these those should must will would can could may might shall do does did not no yes " +
    "after before when then than so if we our you your they them their there here also " +
    "just only all any each every some such very want need needs please"
  ).split(" "),
);

/** Significant tokens: lower-case words of 3+ letters (minus stopwords) and every number. */
export function significantTokens(text: string): { words: Set<string>; numbers: Set<string> } {
  const words = new Set<string>();
  const numbers = new Set<string>();
  for (const tok of String(text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (!tok) continue;
    if (/^\p{N}+$/u.test(tok)) numbers.add(tok);
    else if (tok.length >= 3 && !STOPWORDS.has(tok)) words.add(tok);
  }
  return { words, numbers };
}

/**
 * Does `criterion` cover `answer`? Every NUMBER in the answer must appear (a "30-minute
 * expiry" is not covered by "links expire") and at least half of its significant words.
 * Deliberately strict: a false "not covered" only asks the human to look; a false
 * "covered" would hide a dropped requirement.
 */
export function criterionCovers(criterion: string, answer: string): boolean {
  const a = significantTokens(answer);
  if (a.words.size === 0 && a.numbers.size === 0) return false;
  const c = significantTokens(criterion);
  for (const n of a.numbers) if (!c.numbers.has(n)) return false;
  if (a.words.size === 0) return true;
  let hit = 0;
  for (const w of a.words) if (c.words.has(w)) hit += 1;
  return hit * 2 >= a.words.size;
}

/** The agreed requirements no criterion covers (the confirmation step surfaces these). */
export function uncoveredRequirements(
  agreed: readonly AgreedRequirement[],
  criteria: readonly string[],
): AgreedRequirement[] {
  return agreed.filter((r) => !criteria.some((c) => criterionCovers(c, r.answer)));
}

/** The acceptance-criterion text an agreed requirement becomes (≤ 2000 chars). */
export function agreedRequirementCriterion(r: AgreedRequirement): string {
  const q = (r.question ?? "").trim();
  const text = `Agreed during planning: ${r.answer.trim()}${q ? ` (in answer to: "${q}")` : ""}`;
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}
