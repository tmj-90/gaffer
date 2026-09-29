import { createHash } from "node:crypto";

import type { Db } from "../db/connection.js";

/**
 * ACCEPTANCE GATE: the canonical contract hash — sha256 over the ticket's title,
 * description, acceptance-criterion texts (in sort order) and raw test_contract, joined
 * by NUL. The runner's tester computes the SAME hash (runner/bin/tester-run.mjs
 * `contractHash`) from the same raw rows before it runs and records it on its verdict.
 * Dispatch uses it twice: at record time (an agent verdict whose hash differs from the
 * contract on record is refused — it tested something else) and at report time (a
 * contract edited after the PASS makes the build read `stale`).
 */
export function contractHash(db: Db, ticketId: string): string | null {
  try {
    const t = db
      .prepare("SELECT title, description, test_contract FROM tickets WHERE id = ?")
      .get(ticketId) as
      { title: string; description: string; test_contract: string | null } | undefined;
    if (!t) return null;
    const acs = db
      .prepare("SELECT text FROM acceptance_criteria WHERE ticket_id = ? ORDER BY sort_order ASC")
      .all(ticketId) as Array<{ text: string }>;
    return createHash("sha256")
      .update(
        [
          t.title ?? "",
          t.description ?? "",
          ...acs.map((a) => a.text ?? ""),
          t.test_contract ?? "",
        ].join("\u0000"),
      )
      .digest("hex");
  } catch {
    return null;
  }
}

/** The replay outcomes a tester verdict can carry (see tester-run.mjs). */
export const REPLAY_STATES = ["passed", "failed", "skipped"] as const;
export type ReplayState = (typeof REPLAY_STATES)[number];

/**
 * The structured binding on a tester verdict. `tested_commit` is the exact commit the
 * tester ran against; `contract_hash` the contract it tested; `replay` whether the
 * runner re-ran the tester's tests on a CLEAN checkout of that commit (so a tester that
 * changed build output or anything outside git's view cannot pass the candidate).
 */
export interface VerdictBinding {
  tested_commit?: string;
  contract_hash?: string;
  replay?: ReplayState;
}
