#!/usr/bin/env node
// Gaffer factory — skill-selection telemetry writer.
//
// Appends one JSONL record per delivery capturing which skills were SELECTED
// (mounted / recommended for the ticket) and, best-effort, which were APPLIED
// (their name appears in the agent's raw output). This is the "instrument first
// so pruning isn't blind" step: the data-driven prune of the ~50 generic skills
// is a LATER follow-up that needs this usage trail accumulated over time.
//
// FAIL-SOFT by contract: any error (bad args, unreadable scan file, unwritable
// output) exits 0 without throwing — telemetry must NEVER fail a delivery.
//
// Usage:
//   record-skill-usage.mjs --ticket 42 --role delivery --stack typescript-react \
//     --selected "run-tests,run-lint,frontend-component" \
//     [--applied "run-tests"] [--scan /path/to/agent-output.json] \
//     --out /path/to/skills-telemetry.jsonl
//
// Exported helpers are unit-tested directly (see test/skill-telemetry.test.mjs).

import { appendFileSync, readFileSync } from "node:fs";

/** Split a comma/whitespace/newline-separated list into a de-duped, ordered array. */
export function parseList(value) {
  const seen = new Set();
  const out = [];
  for (const raw of String(value ?? "").split(/[\s,]+/)) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Best-effort "applied" detection: a SELECTED skill counts as applied when its
 * exact name appears anywhere in the agent's output text. Word-boundary matched
 * so `run-tests` doesn't spuriously match a longer token. Never throws.
 */
export function detectApplied(selected, outputText) {
  const text = String(outputText ?? "");
  if (!text) return [];
  return selected.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(text);
  });
}

/** Build the telemetry record (pure — no I/O). */
export function buildRecord({ ticket, role, stack, selected, applied }) {
  return {
    ts: new Date().toISOString(),
    ticket: ticket || null,
    role: role || null,
    stack: stack || null,
    count: selected.length,
    selected,
    applied,
  };
}

export function parseArgs(argv) {
  const opts = {
    ticket: "",
    role: "",
    stack: "",
    selected: "",
    applied: "",
    scan: "",
    out: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)] ?? "";
    switch (arg) {
      case "--ticket":
        opts.ticket = next();
        break;
      case "--role":
        opts.role = next();
        break;
      case "--stack":
        opts.stack = next();
        break;
      case "--selected":
        opts.selected = next();
        break;
      case "--applied":
        opts.applied = next();
        break;
      case "--scan":
        opts.scan = next();
        break;
      case "--out":
        opts.out = next();
        break;
      default:
        break;
    }
  }
  return opts;
}

/** Compose a record from parsed opts, reading the scan file if provided. */
export function recordFromOpts(opts) {
  const selected = parseList(opts.selected);
  const explicit = parseList(opts.applied);
  let scanned = [];
  if (opts.scan) {
    try {
      scanned = detectApplied(selected, readFileSync(opts.scan, "utf8"));
    } catch {
      scanned = [];
    }
  }
  const applied = parseList([...explicit, ...scanned].join(","));
  return buildRecord({ ...opts, selected, applied });
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.out) return; // nowhere to write — nothing to do
    const record = recordFromOpts(opts);
    appendFileSync(opts.out, JSON.stringify(record) + "\n");
  } catch {
    // Fail-soft: telemetry must never fail a delivery.
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
