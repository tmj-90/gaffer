#!/usr/bin/env node
// =====================================================================
// Node entrypoint for the tick.sh delivery CONTEXT-PRIMER blocks
// (P1b context assembly, docs/tick-sh-runtime-migration.md).
// ---------------------------------------------------------------------
// The two live primer blocks are rendered today as inline python inside the
// bash primer (runner/lib/context-primer.sh): gaffer_prime_context_block
// (:39, the "PRIOR CONTEXT (file cards)" block) and gaffer_product_context_block
// (:216, the "PRODUCT CONTEXT" block). This is the typed render seam for that
// text: it routes the render through the golden-tested pure renderers
// (formatFileCardsBlock / formatProductContextBlock, ./contextPrimer.ts) so the
// crew golden test (packages/crew/test/tick-context-primer.test.ts) IS the live
// behaviour once the bash primer routes its block render through this CLI (a
// later, flag-gated slice — this entrypoint lands first, proven byte-identical
// to the captured bash goldens, exactly as renderMcpCli.ts / renderPromptCli.ts
// did before their seams were wired).
//
// Dependency surface is kept as tiny as the other two entrypoints: this imports
// ONLY ./contextPrimer.js — NOT the crew CLI, dispatch, or zod — so startup
// stays fast and side-effect-free.
//
// CONTRACT (the raw memory-CLI JSON on STDIN; kind + optional out on argv):
//   node renderContextPrimerCli.js --kind file-cards      [--out <path>]  < packet.json
//   node renderContextPrimerCli.js --kind product-context [--out <path>]  < rows.json
// The stdin payload is the EXACT memory-CLI output the bash primer already
// captures — for file-cards the `memory cards-for-scope --json` packet, for
// product-context the `memory search --json` rows array — so the future seam can
// pipe it straight through with no reshaping.
//
// BYTE-IDENTITY: the renderers return the block verbatim (no added/stripped
// trailing newline — the bash primer's `$( … )` capture strips the trailing
// newlines, asserted by the crew golden test), and this writes it with
// writeFileSync / stdout.write (no console.log — that would append a byte).
// Output is therefore byte-identical to the bash primer block for the same input.
//
// FAIL-SOFT (the DELIBERATE difference from renderMcpCli / renderPromptCli, which
// fail CLOSED): a primer error must NEVER block a delivery that has otherwise
// passed its gates (runner/CLAUDE.md; gaffer_prime_context_block /
// gaffer_product_context_block both return "" on any failure). So bad JSON, an
// unknown --kind, or a render error renders the EMPTY block and exits 0 — the
// caller then proceeds with no primer context, exactly as the bash path does.
// The error text is written to stderr (for the runner LOG), never to stdout.
// =====================================================================

import { readFileSync, writeFileSync } from "node:fs";

import {
  formatFileCardsBlock,
  formatProductContextBlock,
  type CardsForScopePacket,
  type ProductContextRow,
} from "./contextPrimer.js";

/** Parse an optional `--<name> <value>` arg; returns "" when absent. */
function parseFlag(argv: string[], name: string): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] ?? "";
  }
  return "";
}

function main(): void {
  const argv = process.argv.slice(2);
  const kind = parseFlag(argv, "--kind");
  const out = parseFlag(argv, "--out");

  let rendered: string;
  try {
    const raw = readFileSync(0, "utf8"); // stdin (fd 0), read in full
    const doc: unknown = JSON.parse(raw);
    if (kind === "product-context") {
      // memory search --json → ProductContextRow[]; a non-array is treated as
      // empty (fail-soft), matching gaffer_product_context_block.
      rendered = formatProductContextBlock(Array.isArray(doc) ? (doc as ProductContextRow[]) : []);
    } else if (kind === "file-cards") {
      // memory cards-for-scope --json → CardsForScopePacket; a non-object packet
      // renders empty (fail-soft), matching gaffer_prime_context_block.
      rendered =
        doc && typeof doc === "object" ? formatFileCardsBlock(doc as CardsForScopePacket) : "";
    } else {
      // Unknown/absent kind: nothing sensible to render — fail soft to empty.
      process.stderr.write(
        `render-context-primer: unknown --kind "${kind}" (expected file-cards|product-context)\n`,
      );
      rendered = "";
    }
  } catch (err) {
    // FAIL-SOFT: bad JSON / read / render error → empty block, exit 0.
    process.stderr.write(
      `render-context-primer: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    rendered = "";
  }

  // writeFileSync / stdout.write — NOT console.log: the render must land
  // byte-identical, so no extra trailing newline may be introduced.
  if (out) writeFileSync(out, rendered);
  else process.stdout.write(rendered);
}

main();
