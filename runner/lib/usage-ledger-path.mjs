// =====================================================================
// lib/usage-ledger-path.mjs — where the usage ledger lives. ONE resolver shared by the
// writer (lib/usage-ledger.mjs appendUsageRecord) and the paid-launch admission check
// (lib/budget-admission.mjs), so the check always reads the file the writer appends to.
// A separate module (no imports) because usage-ledger.mjs imports lib/worker.mjs, which
// imports budget-admission.mjs: sharing it this way keeps that import graph acyclic.
// =====================================================================
import { readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const LEDGER_FILENAME = "usage-ledger.jsonl";

/** True for a GAFFER_USAGE_LEDGER value that turns the ledger OFF. */
export function ledgerDisabled(value) {
  return /^(0|off|false|no)$/i.test(String(value ?? "").trim());
}

/**
 * The ledger file, or null when there is none. GAFFER_USAGE_LEDGER wins; `0`, `off`,
 * `false` or `no` turn the ledger off (they used to be taken as a file name, so
 * `GAFFER_USAGE_LEDGER=0` wrote a file called `0` into whatever directory the runner
 * was in). A relative path resolves under GAFFER_DATA when that is set. Without an
 * explicit path the ledger is $GAFFER_DATA/usage-ledger.jsonl, gated on GAFFER_DATA.
 */
export function resolveLedgerPath(env = process.env) {
  const explicit = (env.GAFFER_USAGE_LEDGER ?? "").trim();
  if (explicit) {
    if (ledgerDisabled(explicit)) return null;
    if (!isAbsolute(explicit) && env.GAFFER_DATA) return join(env.GAFFER_DATA, explicit);
    return explicit;
  }
  return env.GAFFER_DATA ? join(env.GAFFER_DATA, LEDGER_FILENAME) : null;
}

export const HOLD_FILENAME = "usage-ledger.held.jsonl";

/**
 * UNBOOKED CALLS (external review 16): where a call's ledger row is kept when the append to
 * the ledger failed, so its cost does not vanish: $GAFFER_DATA/usage-ledger.held.jsonl, or
 * null without GAFFER_DATA (or when that is the ledger itself). Budget admission counts each
 * row in it as an unknown cost; `usage-ledger.mjs --reconcile` moves them into the ledger.
 */
export function resolveHoldPath(env = process.env) {
  const data = String(env.GAFFER_DATA ?? "").trim();
  if (!data) return null;
  const hold = join(data, HOLD_FILENAME);
  return hold === resolveLedgerPath(env) ? null : hold;
}

/**
 * The hold files a `--reconcile` has claimed and not yet retired
 * (<hold>.claim-<pid>-<ms>): the reconcile renames the hold file to one first, so a
 * failed append while it runs starts a fresh hold file instead of being retired with the
 * rows it moved. Budget admission counts their rows as held too (a reconcile that failed
 * or died part way keeps them unknown cost); the next reconcile finishes them.
 * → [] without a hold path or when its directory cannot be listed.
 */
export function resolveHoldClaims(env = process.env) {
  const hold = resolveHoldPath(env);
  if (!hold) return [];
  const prefix = `${HOLD_FILENAME}.claim-`;
  try {
    return readdirSync(dirname(hold))
      .filter((n) => n.startsWith(prefix))
      .sort()
      .map((n) => join(dirname(hold), n));
  } catch {
    return [];
  }
}
