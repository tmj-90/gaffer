// =====================================================================
// CI check-status parser — strangler port of gaffer_parse_checks
// (runner/lib/ci-gate.sh:64; P3/P4 gate). Pure text-in → verdict-out: it maps a
// tab-separated checks table into ONE verdict string the CI gate acts on. The
// actual CI poll (gh/API call) stays in bash; this only decides.
//
// Rows are `<name>\t<status>\t<conclusion>\t<url>`. Byte-identical to the awk:
//   • empty input                                   → "unknown"
//   • FIRST row whose status OR conclusion (lower-cased) matches /fail|error/
//                                                    → "fail:<name|unknown>|<url>"
//   • else any row status/conclusion ~ pending|queue|in_progress|waiting
//                                                    → "pending"
//   • else                                          → "pass"
// tolower() is awk's ASCII lower (C locale); statuses are ASCII, so an ASCII
// lower matches byte-for-byte.
// =====================================================================

/** awk `tolower()` — ASCII-only, matching the C-locale awk. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

const RED = /fail|error/;
const RUNNING = /pending|queue|in_progress|waiting/;

/** Map a `gh`-style checks table to the CI gate verdict (see header). */
export function parseChecks(checksOutput: string): string {
  if (checksOutput === "") return "unknown";
  const lines = checksOutput.split("\n");

  // First failing row wins (the awk `exit` on first match).
  for (const line of lines) {
    const c = line.split("\t");
    if (RED.test(asciiLower(c[1] ?? "")) || RED.test(asciiLower(c[2] ?? ""))) {
      const name = c[0] ? c[0] : "unknown"; // ${check_name:-unknown}
      const url = c[3] ?? ""; // ${check_url:-}
      return `fail:${name}|${url}`;
    }
  }

  // Any still-running row → pending.
  for (const line of lines) {
    const c = line.split("\t");
    if (RUNNING.test(asciiLower(c[1] ?? "")) || RUNNING.test(asciiLower(c[2] ?? ""))) {
      return "pending";
    }
  }

  return "pass";
}
