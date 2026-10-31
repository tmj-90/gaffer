// S16 review gate edge cases — HELD. Every step lives on #/review, which the
// review-packet and gate-integrity packages are rebuilding (verdict strip, DoD
// tally, criteria table, reviewed-commit pin). Writing these assertions now would
// pin markup that is about to change, so the suite records each as a SKIP with that
// reason (see E2E-MATRIX "Review-view steps to hold").
export const needsRepo = false;
export default async function s16(t) {
  for (const step of [
    "packet strip / DoD checklist rows (verdict strip replaces them)",
    "DoD tally and test-count rows (---DOD-TALLY)",
    "Approve refused while a checked AC is unverified (criteria table)",
    "reviewed-commit pin and 'moved since the review approved it' hold",
    "repo_not_on_disk / empty-diff Approve guard banner",
    "per-file diff sections, file jumper, risk marks",
    "Review layout + a11y re-baseline",
  ])
    t.skip(`HELD for review-packet / gate-integrity: ${step}`);
}
