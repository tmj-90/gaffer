// =====================================================================
// Ticket slug + delivery branch name — TS port of `gaffer_ticket_slug` and
// the WORK_BRANCH derivation in runner/tick.sh (P1b context assembly,
// docs/tick-sh-runtime-migration.md).
// ---------------------------------------------------------------------
// The slug derivation is SHARED by the normal delivery path AND the
// greenfield bootstrap so both mint the identical `gaffer/ticket-N-<slug>`
// branch shape the reviewer's fallback grep (`gaffer/ticket-$NUM-[a-z0-9-]*`)
// expects. Port of the bash pipeline at tick.sh:495–507:
//   lowercase → non-[a-z0-9] runs → '-' → collapse → trim → ≤6 dash-separated
//   words → ≤50 chars → trim trailing '-' → empty → "ticket".
//
// PARITY NOTE: bash `tr -c 'a-z0-9' '-'` operates on BYTES, so a multibyte
// (non-ASCII) character becomes several '-' which `tr -s` then collapses to
// one — exactly what a single [^a-z0-9]+ → "-" replacement produces. After
// that stage the string is pure ASCII, so the char-indexed `cut`s match
// String.slice.
// =====================================================================

/** Derive the delivery-branch slug from a ticket title (tick.sh:495–507). */
export function ticketSlug(title: string): string {
  const s = title
    // tr '[:upper:]' '[:lower:]' in the C locale lowers ASCII ONLY — a JS
    // .toLowerCase() would additionally fold non-ASCII (e.g. İ → i̇) and drift.
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-") // tr -c 'a-z0-9' '-' | tr -s '-'
    .replace(/^-+|-+$/g, "") // sed -E 's/^-+//; s/-+$//'
    .split("-")
    .slice(0, 6) // cut -d- -f1-6
    .join("-")
    .slice(0, 50) // cut -c1-50 (ASCII-only at this point)
    .replace(/-+$/, ""); // sed -E 's/-+$//'
  return s === "" ? "ticket" : s;
}

/** The delivery branch for a ticket: `gaffer/ticket-<N>-<slug>` (tick.sh:1276). */
export function workBranchName(ticketNumber: number | string, title: string): string {
  return `gaffer/ticket-${ticketNumber}-${ticketSlug(title)}`;
}
