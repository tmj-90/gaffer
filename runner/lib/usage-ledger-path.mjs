// =====================================================================
// lib/usage-ledger-path.mjs — where the usage ledger lives. ONE resolver shared by the
// writer (lib/usage-ledger.mjs appendUsageRecord) and the paid-launch admission check
// (lib/budget-admission.mjs), so the check always reads the file the writer appends to.
// A separate module (no imports) because usage-ledger.mjs imports lib/worker.mjs, which
// imports budget-admission.mjs: sharing it this way keeps that import graph acyclic.
// =====================================================================
import { isAbsolute, join } from "node:path";

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
