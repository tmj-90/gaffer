#!/usr/bin/env node
// runner/eval/fixture.mjs — the JSON side of the gate replay harness.
//
// replay.sh runs the REAL gates (bash); this helper reads fixture.json, emits the
// inputs those gates need, and turns the recorded verdicts into results.json with a
// pass/fail comparison against each fixture's expected block. No dependencies.
//
//   fixture.mjs read <fixture.json> <key>       print one scalar field ("" if unset)
//   fixture.mjs gate-row <fixture.json> <wt>    the TAB row gaffer_run_dod_gates reads
//   fixture.mjs ticket-json <fixture.json>      the ticket payload gaffer_run_ac_checks parses
//   fixture.mjs env <fixture.json>              `KEY=value` lines from fixture.env
//   fixture.mjs report <records.ndjson> <fixtures-dir> <out.json>
//                                               compare actual vs expected, write results.json,
//                                               print a table; exit 1 on any mismatch
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const [, , cmd, ...args] = process.argv;

function loadFixture(file) {
  const fx = JSON.parse(readFileSync(file, "utf8"));
  if (!fx || typeof fx !== "object") throw new Error(`${file}: not a JSON object`);
  if (!fx.expected || typeof fx.expected !== "object")
    throw new Error(`${file}: missing "expected"`);
  return fx;
}

// A gate value: a string is the command (empty ⇒ enabled, no command ⇒ SKIP);
// false/null ⇒ the gate is disabled by config. The TAB-row contract needs `-` for
// an empty command because TAB is IFS whitespace (see runner/lib/dod.sh).
function gateCell(v) {
  if (v === false || v === null) return { on: "0", cmd: "-" };
  const s = String(v ?? "")
    .replace(/[\t\n\r]/g, " ")
    .trim();
  return { on: "1", cmd: s === "" ? "-" : s };
}

switch (cmd) {
  case "read": {
    const [file, key] = args;
    const fx = loadFixture(file);
    const v = key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), fx);
    process.stdout.write(v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
    break;
  }
  case "gate-row": {
    const [file, wt] = args;
    const fx = loadFixture(file);
    const g = fx.gates || {};
    const t = gateCell(g.tests),
      tc = gateCell(g.typecheck),
      l = gateCell(g.lint);
    process.stdout.write(["repo", wt, t.on, tc.on, l.on, t.cmd, tc.cmd, l.cmd].join("\t") + "\n");
    break;
  }
  case "ticket-json": {
    const [file] = args;
    const fx = loadFixture(file);
    const acs = (fx.acceptance || []).map((a, i) => ({
      id: `ac-${i + 1}`,
      text: String(a.text || `AC ${i + 1}`),
      check_command: a.check ? String(a.check) : null,
      status: "pending",
    }));
    process.stdout.write(
      JSON.stringify({ number: 1, title: fx.title || file, acceptanceCriteria: acs }),
    );
    break;
  }
  case "env": {
    const [file] = args;
    const fx = loadFixture(file);
    for (const [k, v] of Object.entries(fx.env || {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`${file}: bad env key ${k}`);
      process.stdout.write(`${k}=${String(v).replace(/[\n\r]/g, " ")}\n`);
    }
    break;
  }
  case "report": {
    const [ndjson, fxDir, out] = args;
    const records = readFileSync(ndjson, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const FIELDS = ["hygiene", "minimalism", "dod", "ac", "outcome"];
    const fixtures = [];
    let mismatches = 0;
    for (const r of records) {
      const fx = loadFixture(join(fxDir, r.name, "fixture.json"));
      const exp = fx.expected;
      const diffs = [];
      for (const f of FIELDS) {
        if (exp[f] !== undefined && String(exp[f]) !== String(r.actual[f]))
          diffs.push(
            `${f}: expected ${JSON.stringify(exp[f])}, got ${JSON.stringify(r.actual[f])}`,
          );
      }
      if (exp.flags !== undefined) {
        const want = [...exp.flags].sort().join(","),
          got = [...(r.actual.flags || [])].sort().join(",");
        if (want !== got) diffs.push(`flags: expected [${want}], got [${got}]`);
      }
      if (exp.dod_failed !== undefined) {
        const want = [...exp.dod_failed].sort().join(","),
          got = [...(r.actual.dod_failed || [])].sort().join(",");
        if (want !== got) diffs.push(`dod_failed: expected [${want}], got [${got}]`);
      }
      if (r.error) diffs.push(`replay error: ${r.error}`);
      if (diffs.length) mismatches++;
      fixtures.push({
        name: r.name,
        title: fx.title || r.name,
        ok: diffs.length === 0,
        expected: exp,
        actual: r.actual,
        mismatches: diffs,
        duration_ms: r.duration_ms,
        gate_rows: r.gate_rows,
      });
    }
    const result = {
      ok: mismatches === 0,
      fixtures: fixtures.length,
      mismatched: mismatches,
      generated_at: new Date().toISOString(),
      results: fixtures,
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
    const w = Math.max(8, ...fixtures.map((f) => f.name.length));
    for (const f of fixtures) {
      const a = f.actual;
      console.log(
        `  ${f.ok ? "ok  " : "FAIL"} ${f.name.padEnd(w)}  hygiene=${a.hygiene} minimalism=${a.minimalism} dod=${a.dod} ac=${a.ac} → ${a.outcome}${(a.flags || []).length ? ` [${a.flags.join(",")}]` : ""}`,
      );
      for (const d of f.mismatches) console.log(`         ${d}`);
    }
    console.log(
      `${result.ok ? "PASS" : "FAIL"}: ${fixtures.length - mismatches}/${fixtures.length} fixtures match their expected verdicts (${out})`,
    );
    process.exit(result.ok ? 0 : 1);
    break;
  }
  default:
    console.error("usage: fixture.mjs read|gate-row|ticket-json|env|report ...");
    process.exit(2);
}
