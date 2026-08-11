// =====================================================================
// DoD results-file summary text-processors — strangler port of two more of
// runner/lib/dod.sh's awk helpers (gaffer_dod_summary_line at :252 and
// gaffer_dod_executed_count at :273), the siblings of distillOutput /
// extractFailure. Pure text-in → text-out, so the unit test IS the behaviour.
//
// A DoD "results file" is TAB-separated rows; the two functions here only read
// the `GATE\t<gate>\t<repo>\t<status>\t<rc>\t<note>` rows (every other line —
// the framed ---DOD-OUTPUT--- transcript blocks — is ignored, exactly as the awk
// `$1=="GATE"` guard does). Field indices mirror the awk 1-based fields:
//   parts[0] "GATE"  parts[1] gate  parts[2] repo  parts[3] status  parts[4] rc
//
// BYTES, NOT UNICODE: the runner's awk is mawk (byte-oriented). Callers pass the
// file bytes decoded 1:1 (latin1) so these functions see and preserve the exact
// bytes mawk would — see dodDistillCli.ts.
// =====================================================================

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
  const failed: string[] = [];
  for (const line of text.split("\n")) {
    const p = line.split("\t");
    if (p[0] !== "GATE") continue;
    total += 1;
    const status = p[3];
    if (status === "PASS") {
      pass += 1;
    } else if (status === "FAIL") {
      fail += 1;
      failed.push(`${p[1]}@${p[2]}`);
    } else {
      skip += 1;
    }
  }
  let out = `${total} gate(s): ${pass} pass, ${skip} skip, ${fail} fail`;
  if (fail > 0) out += ` (failed: ${failed.join(", ")})`;
  return out;
}

/**
 * Count the gates that actually EXECUTED (status PASS or FAIL), excluding SKIP —
 * matches gaffer_dod_executed_count's awk. Returned as a number; the CLI renders
 * it as `<n>\n` to mirror the awk `print n+0` (which appends the ORS newline).
 */
export function executedCount(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    const p = line.split("\t");
    if (p[0] === "GATE" && (p[3] === "PASS" || p[3] === "FAIL")) n += 1;
  }
  return n;
}
