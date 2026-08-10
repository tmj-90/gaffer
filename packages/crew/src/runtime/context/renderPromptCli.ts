#!/usr/bin/env node
// =====================================================================
// Node entrypoint for the tick.sh delivery/bootstrap PROMPT render
// (P1b context assembly, docs/tick-sh-runtime-migration.md).
// ---------------------------------------------------------------------
// The live delivery prompt is assembled today as bash heredocs in
// runner/tick.sh (fresh at :1516, resume at :1485, bootstrap at :919). This
// is the typed render seam for that text: it routes the render through the
// golden-tested pure renderers (renderDeliveryPrompt / renderBootstrapPrompt,
// ./deliveryPrompt.ts) so the crew golden test IS the live behaviour once
// tick.sh routes its $PROMPT through this CLI (a later, flag-gated slice —
// this entrypoint lands first, proven byte-identical to the captured bash
// golden, exactly as renderMcpCli.ts did before the MCP seam was wired).
//
// Dependency surface is kept as tiny as renderMcpCli.ts: this imports ONLY
// ./deliveryPrompt.js + ./ticketSlug.js + ../../util/errors.js — NOT the crew
// CLI, dispatch, or zod — so startup stays fast and side-effect-free.
//
// CONTRACT (structured inputs as JSON on STDIN; one --out path on argv):
//   node renderPromptCli.js [--out <path>]   < inputs.json
// Inputs arrive on stdin (not argv/env) because the delivery prompt's inputs
// are multi-line/structured (context blocks, review reasons, the write-repo
// list) — a single JSON document avoids any shell-escaping or delimiter risk.
// The JSON is the SAME shape runner/test/capture-context-golden.sh emits and
// packages/crew/test/tick-context-assembly.test.ts consumes:
//   kind        "delivery" (default) | "bootstrap"
//   delivery →  DeliveryPromptInputs fields; workBranch OPTIONAL — when absent
//               it is derived via workBranchName(ticketNumber, title), matching
//               the crew golden test's capturedPromptInputs() so the derivation
//               is proven identical to the bash WORK_BRANCH.
//   bootstrap → BootstrapPromptInputs fields (ticketNumber, title, skills,
//               bootstrapDir).
//
// BYTE-IDENTITY: the renderers return the prompt verbatim (no added/stripped
// trailing newline — the heredoc's `read -r -d ''` yields none, asserted by the
// crew golden test), and this writes it with writeFileSync (no console.log —
// that would append a byte). Output is therefore byte-identical to the bash
// heredoc for the same inputs. With no --out the prompt is written to stdout
// verbatim (again no trailing newline added).
//
// FAIL-CLOSED: a CrewError from a renderer (empty ticket/title/workBranch/
// write-repo set / bootstrap dir) is printed to stderr and exits 1, so a
// boundary-less prompt never reaches a live agent launch.
// =====================================================================

import { readFileSync, writeFileSync } from "node:fs";

import { CrewError } from "../../util/errors.js";
import {
  renderBootstrapPrompt,
  renderDeliveryPrompt,
  type BootstrapPromptInputs,
  type DeliveryPromptInputs,
} from "./deliveryPrompt.js";
import { workBranchName } from "./ticketSlug.js";

/** Parse the optional `--out <value>` path arg; unknown flags are ignored. */
function parseOutArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") return argv[i + 1] ?? "";
  }
  return "";
}

interface DeliveryDoc extends Omit<DeliveryPromptInputs, "workBranch"> {
  kind?: "delivery";
  /** Optional — derived from ticketNumber/title when absent (see header). */
  workBranch?: string;
}
interface BootstrapDoc extends BootstrapPromptInputs {
  kind: "bootstrap";
}
type InputDoc = DeliveryDoc | BootstrapDoc;

function render(doc: InputDoc): string {
  if (doc.kind === "bootstrap") {
    return renderBootstrapPrompt({
      ticketNumber: doc.ticketNumber,
      title: doc.title,
      skills: doc.skills,
      bootstrapDir: doc.bootstrapDir,
    });
  }
  // Delivery (default). workBranch falls back to the derived branch so the CLI
  // matches the crew golden test's mapping exactly (proving ticketSlug parity).
  const d = doc as DeliveryDoc;
  const workBranch =
    d.workBranch && d.workBranch !== "" ? d.workBranch : workBranchName(d.ticketNumber, d.title);
  return renderDeliveryPrompt({
    ticketNumber: d.ticketNumber,
    title: d.title,
    resuming: d.resuming,
    skills: d.skills,
    lenses: d.lenses,
    reviewFeedbackReasons: d.reviewFeedbackReasons,
    fileCardsBlock: d.fileCardsBlock,
    productContextBlock: d.productContextBlock,
    workBranch,
    writeRepos: d.writeRepos,
    readRoots: d.readRoots,
    primaryRepo: d.primaryRepo,
  });
}

function main(): void {
  const out = parseOutArg(process.argv.slice(2));
  const raw = readFileSync(0, "utf8"); // stdin (fd 0), read in full
  const doc = JSON.parse(raw) as InputDoc;
  const rendered = render(doc);
  // writeFileSync / stdout.write — NOT console.log: the render must land
  // byte-identical, so no extra trailing newline may be introduced.
  if (out) writeFileSync(out, rendered);
  else process.stdout.write(rendered);
}

try {
  main();
} catch (err) {
  if (err instanceof CrewError) {
    process.stderr.write(`render-prompt: ${err.code}: ${err.message}\n`);
  } else {
    process.stderr.write(`render-prompt: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
}
