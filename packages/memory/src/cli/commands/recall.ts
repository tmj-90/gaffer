/**
 * Memory Feedback Loop CLI verbs.
 *
 *   memory recall-feedback --repo <r> --ticket <id> --outcome <clean|reworked|blocked>
 *       Adjust the confidence of the memory items served into a ticket's
 *       context, based on how the ticket turned out. Bounded + idempotent
 *       (see core/recallFeedback.ts). The runner calls this at ticket outcome.
 *
 *   memory flagged [--repo <r>] [--json]
 *       List lore + file cards flagged for review — knowledge that was in
 *       context for a reworked/blocked ticket. The human surface for the loop.
 *
 * ISOLATION: no imports from dispatch or crew. Memory adjusts its OWN items
 * from its OWN read-event log + the outcome passed in.
 */
import { listFlaggedForReview, recallEffectiveness, recallFeedback } from "../../core/recallFeedback.js";
import type { RecallOutcome } from "../../core/recallFeedback.js";
import { openDb } from "../../db/index.js";
import { getBool, getString } from "../args.js";
import type { parseArgs } from "../args.js";

const OUTCOMES: readonly RecallOutcome[] = ["clean", "reworked", "blocked"];

function isOutcome(v: string): v is RecallOutcome {
  return (OUTCOMES as readonly string[]).includes(v);
}

/**
 * `memory recall-feedback --repo <r> --ticket <id> --outcome <o> [--json]`
 */
export async function cmdRecallFeedback(args: ReturnType<typeof parseArgs>): Promise<number> {
  const repo = getString(args.flags, "repo");
  const ticket = getString(args.flags, "ticket");
  const outcomeRaw = getString(args.flags, "outcome");

  if (!repo || !repo.trim()) {
    process.stderr.write("memory: recall-feedback requires --repo <name>\n");
    return 2;
  }
  if (!ticket || !ticket.trim()) {
    process.stderr.write("memory: recall-feedback requires --ticket <id>\n");
    return 2;
  }
  if (!outcomeRaw || !isOutcome(outcomeRaw)) {
    process.stderr.write(`memory: recall-feedback requires --outcome <${OUTCOMES.join("|")}>\n`);
    return 2;
  }

  const json = getBool(args.flags, "json");
  const db = openDb();
  try {
    const result = recallFeedback(db, {
      repo: repo.trim(),
      ticket: ticket.trim(),
      outcome: outcomeRaw,
    });

    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }

    if (result.alreadyApplied) {
      process.stdout.write(
        `recall-feedback: ${outcomeRaw} already applied for #${ticket} (${repo}) — no change (idempotent)\n`,
      );
      return 0;
    }

    const adjusted = result.loreAdjusted.length + result.cardsAdjusted.length;
    process.stdout.write(
      `recall-feedback: #${ticket} (${repo}) → ${outcomeRaw}\n` +
        `  served: ${result.served}  adjusted: ${adjusted} ` +
        `(lore ${result.loreAdjusted.length}, cards ${result.cardsAdjusted.length})\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memory recall-stats [--repo <r>] [--json]` — read-back view of the feedback
 * loop: how often served knowledge led to a clean outcome vs rework/block, plus
 * a per-day trend. Read-only (never mutates); the dispatch Health surface shells
 * out to this for its recall-effectiveness signal.
 */
export async function cmdRecallStats(args: ReturnType<typeof parseArgs>): Promise<number> {
  const repo = getString(args.flags, "repo");
  const json = getBool(args.flags, "json");
  const db = openDb();
  try {
    const stats = recallEffectiveness(db, repo && repo.trim() ? { repo: repo.trim() } : {});

    if (json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
      return 0;
    }

    if (stats.total === 0) {
      process.stdout.write(`No recall feedback recorded${repo ? ` for '${repo}'` : ""} yet.\n`);
      return 0;
    }

    const eff = stats.effectiveness_pct == null ? "—" : `${stats.effectiveness_pct}%`;
    process.stdout.write(
      `RECALL EFFECTIVENESS${repo ? ` (${repo})` : ""}\n` +
        `  outcomes: ${stats.total}  (clean ${stats.clean}, reworked ${stats.reworked}, blocked ${stats.blocked})\n` +
        `  effectiveness: ${eff} clean  ·  items adjusted: ${stats.items_adjusted}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memory flagged [--repo <r>] [--json]` — list items flagged for review.
 */
export async function cmdFlagged(args: ReturnType<typeof parseArgs>): Promise<number> {
  const repo = getString(args.flags, "repo");
  const json = getBool(args.flags, "json");
  const db = openDb();
  try {
    const items = listFlaggedForReview(db, repo ? { repo: repo.trim() } : {});

    if (json) {
      process.stdout.write(JSON.stringify(items, null, 2) + "\n");
      return 0;
    }

    if (items.length === 0) {
      process.stdout.write(`No items flagged for review${repo ? ` for '${repo}'` : ""}.\n`);
      return 0;
    }

    process.stdout.write(
      `FLAGGED FOR REVIEW (${items.length}) — knowledge in context for reworked/blocked tickets\n\n`,
    );
    for (const it of items) {
      if (it.type === "lore") {
        process.stdout.write(`  [lore] ${it.id}  (${it.confidence}/${it.status})  ${it.title}\n`);
      } else {
        process.stdout.write(`  [card] ${it.id}  ${it.repo}:${it.path}\n`);
      }
    }
    process.stdout.write("\n");
    return 0;
  } finally {
    db.close();
  }
}
