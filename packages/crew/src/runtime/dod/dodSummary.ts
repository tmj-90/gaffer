// =====================================================================
// DoD results-file summary text-processors — strangler port of two more of
// runner/lib/dod.sh's awk helpers (gaffer_dod_summary_line at :252 and
// gaffer_dod_executed_count at :273), the siblings of distillOutput /
// extractFailure. Pure text-in → text-out, so the unit test IS the behaviour.
//
// A DoD "results file" is TAB-separated rows; the two functions here only read
// the `GATE\t<gate>\t<repo>\t<status>\t<rc>\t<note>` rows OUTSIDE the framed
// ---DOD-OUTPUT--- / ---DOD-TALLY--- blocks (those hold the delivered code's own
// output, so a GATE-shaped line inside one is never a runner row). Field indices
// mirror the awk 1-based fields:
//   parts[0] "GATE"  parts[1] gate  parts[2] repo  parts[3] status  parts[4] rc
//
// BYTES, NOT UNICODE: the runner's awk is mawk (byte-oriented). Callers pass the
// file bytes decoded 1:1 (latin1) so these functions see and preserve the exact
// bytes mawk would — see dodDistillCli.ts.
// =====================================================================

/**
 * The runner's GATE rows, split on TAB, in file order — skipping every line inside a
 * `---DOD-OUTPUT …` / `---DOD-TALLY …` frame up to its `---END-DOD-…---` marker.
 */
function gateRows(text: string): string[][] {
  const rows: string[][] = [];
  let inFrame = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("---DOD-OUTPUT ") || line.startsWith("---DOD-TALLY ")) {
      inFrame = true;
      continue;
    }
    if (line.startsWith("---END-DOD-OUTPUT---") || line.startsWith("---END-DOD-TALLY---")) {
      inFrame = false;
      continue;
    }
    if (inFrame) continue;
    const p = line.split("\t");
    if (p[0] === "GATE") rows.push(p);
  }
  return rows;
}

/**
 * One-line human summary of a results file — byte-identical to
 * gaffer_dod_summary_line's awk `printf` (NO trailing newline):
 *   "<total> gate(s): <pass> pass, <skip> skip, <fail> fail[ (failed: g@r, …)]"
 * The failed list is the FAIL rows' "<gate>@<repo>", comma-joined, in file order.
 */
export function summarizeGates(text: string): string {
  let total = 0;
  let pass = 0;
  let skip = 0;
  let fail = 0;
  let flag = 0;
  const failed: string[] = [];
  const flagged: string[] = [];
  for (const p of gateRows(text)) {
    total += 1;
    const status = p[3];
    if (status === "PASS") {
      pass += 1;
    } else if (status === "FAIL") {
      fail += 1;
      failed.push(`${p[1]}@${p[2]}`);
    } else if (status === "FLAG") {
      // GATE INTEGRITY: a FLAG is advisory (never a fail); named so the log shows it.
      flag += 1;
      flagged.push(`${p[1]}@${p[2]}`);
    } else {
      skip += 1;
    }
  }
  let out = `${total} gate(s): ${pass} pass, ${skip} skip, ${fail} fail`;
  // Only when present, so every pre-integrity summary stays byte-identical.
  if (flag > 0) out += `, ${flag} flag`;
  if (fail > 0) out += ` (failed: ${failed.join(", ")})`;
  if (flag > 0) out += ` (flagged: ${flagged.join(", ")})`;
  return out;
}

/**
 * Count the gates that actually EXECUTED (status PASS or FAIL), excluding SKIP and
 * the GATE INTEGRITY row (it checks the gates; it verifies nothing itself) — matches
 * gaffer_dod_executed_count's awk. Returned as a number; the CLI renders
 * it as `<n>\n` to mirror the awk `print n+0` (which appends the ORS newline).
 */
export function executedCount(text: string): number {
  let n = 0;
  for (const p of gateRows(text)) {
    // The `integrity` row is a check ON the gates, not a gate that verified the work:
    // a delivery whose only row is integrity PASS still executed zero gates.
    if (p[1] !== "integrity" && (p[3] === "PASS" || p[3] === "FAIL")) n += 1;
  }
  return n;
}
