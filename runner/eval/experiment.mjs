#!/usr/bin/env node
// runner/eval/experiment.mjs: the JSON side of the MATCHED EXPERIMENT runner (delta
// roadmap gap 4, P2; docs/eval-harness.md "Matched-ticket comparison").
//
// experiment.sh runs every (ticket, arm) delivery through the worker seam and the gate
// pipeline tick.sh uses; this module plans the runs (the tickets, the arms as setting
// overrides, a seeded random order), renders the experiment's delivery brief, and turns
// the runs into results.json and report.md: per ticket the paired difference of each arm
// against the baseline (acceptance, attempts, spend, the judge score when there is one),
// then the mean, a 95% interval and n over tickets. A ticket an arm never submitted
// counts as that arm's failure, never as missing data. No dependencies.
//
//   experiment.mjs plan --out <dir> (--fixtures <dir> [--only a,b] | --manifests <dir>
//                  [--tickets 3,4]) --arm <spec> --arm <spec> [...] [--seed N]
//                  [--max-tickets N] [--mode stub|live]          → <out>/plan.json
//   experiment.mjs prompt --plan <plan.json> --ticket <id> --arm <name> [--failure <file>]
//   experiment.mjs model-flag --plan <plan.json> --ticket <id> --arm <name>
//   experiment.mjs judge-score --plan <plan.json> --ticket <id> --diff <file>
//   experiment.mjs report --plan <plan.json> --runs <runs.ndjson> --out <dir>
//
// An arm spec is `name[:key=value,key=value]`; the first arm is the baseline. Keys:
//   tier=<registry tier>   model=<model id>      provider=claude-code|command
//   memory=on|off          packet=0|1            context=full|minimal
//   scout=off|auto|on      stub=apply|noop|patch:<file in the fixture dir>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadRegistry, routeModel } from "../bin/route-model.mjs";

export const RESULTS_SCHEMA = "gaffer.experiment/1";

const ARM_KEYS = {
  tier: /^[A-Za-z0-9_-]{1,32}$/,
  model: /^[A-Za-z0-9._:/@+-]{1,80}$/,
  provider: /^(?:claude-code|command)$/,
  memory: /^(?:on|off)$/,
  packet: /^[01]$/,
  context: /^(?:full|minimal)$/,
  scout: /^(?:off|auto|on)$/,
  stub: /^(?:apply|noop|patch:[A-Za-z0-9._-]{1,64}\.patch)$/,
};

/** Parse `name[:k=v,k=v]`; throws on an unknown key or value. */
export function parseArm(spec, registry = loadRegistry()) {
  const s = String(spec ?? "");
  const colon = s.indexOf(":");
  const name = (colon < 0 ? s : s.slice(0, colon)).trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error(`bad arm name in "${s}"`);
  const overrides = {};
  if (colon >= 0) {
    for (const kv of s
      .slice(colon + 1)
      .split(",")
      .filter(Boolean)) {
      const eq = kv.indexOf("=");
      const k = (eq < 0 ? kv : kv.slice(0, eq)).trim();
      const v = eq < 0 ? "" : kv.slice(eq + 1).trim();
      if (!Object.prototype.hasOwnProperty.call(ARM_KEYS, k))
        throw new Error(
          `arm ${name}: unknown setting "${k}" (allowed: ${Object.keys(ARM_KEYS).join(", ")})`,
        );
      if (!ARM_KEYS[k].test(v)) throw new Error(`arm ${name}: bad value for ${k}: "${v}"`);
      if (k === "tier" && !Object.prototype.hasOwnProperty.call(registry.tiers, v))
        throw new Error(`arm ${name}: tier "${v}" is not in the model registry`);
      overrides[k] = v;
    }
  }
  return { name, overrides };
}

/** A small seeded PRNG (mulberry32), so an order can be reproduced from its seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy, with the seeded PRNG. */
export function shuffle(list, seed) {
  const out = [...list];
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

/** The tickets from gate-replay-style fixtures (each a base repo + a recorded delivery). */
function fixtureTickets(dir, only) {
  const names = readdirSync(dir)
    .filter((n) => !n.startsWith("_") && existsSync(join(dir, n, "fixture.json")))
    .filter((n) => !only || only.includes(n))
    .sort();
  return names.map((n) => {
    const fx = readJson(join(dir, n, "fixture.json"));
    const base = String(fx.base || "_base/taskflow-mini");
    return {
      id: n,
      source: "fixture",
      fixture: join(dir, n, "fixture.json"),
      fixture_dir: join(dir, n),
      base_dir: base.startsWith("/") ? base : join(dir, base),
      patch: join(dir, n, String(fx.delivery || "delivery.patch")),
      risk: ["low", "medium", "high", "critical"].includes(fx.risk) ? fx.risk : "medium",
      acceptance_test:
        fx.experiment && typeof fx.experiment.acceptance_test === "string"
          ? fx.experiment.acceptance_test
          : null,
    };
  });
}

/**
 * The tickets from the runner's replay manifests: each one's latest attempt with a known
 * base and head commit. The stub agent replays the recorded change (base..head); the
 * gates use the recorded test command.
 */
function manifestTickets(dir, only, outDir) {
  const latest = new Map();
  for (const f of readdirSync(dir).filter((x) => /^\d+-\d+\.json$/.test(x))) {
    let m;
    try {
      m = readJson(join(dir, f));
    } catch {
      continue;
    }
    if (!m || m.schema !== "gaffer.replay-manifest/1" || !m.ticket?.number) continue;
    if (only && !only.includes(String(m.ticket.number))) continue;
    const r = Array.isArray(m.repos) ? m.repos[0] : null;
    if (!r || !r.base_commit || !r.head_commit || !r.path) continue;
    const prev = latest.get(m.ticket.number);
    if (!prev || m.attempt.n > prev.attempt.n) latest.set(m.ticket.number, m);
  }
  mkdirSync(join(outDir, "manifest-fixtures"), { recursive: true });
  return [...latest.values()]
    .sort((a, b) => a.ticket.number - b.ticket.number)
    .map((m) => {
      const r = m.repos[0];
      const fxPath = join(outDir, "manifest-fixtures", `${m.ticket.number}.json`);
      writeFileSync(
        fxPath,
        JSON.stringify({
          title: `replay of ticket #${m.ticket.number}`,
          note: "",
          acceptance: [],
          gates: { tests: r.test_command || "", typecheck: false, lint: false },
          expected: {},
        }),
      );
      return {
        id: `ticket-${m.ticket.number}`,
        source: "manifest",
        fixture: fxPath,
        fixture_dir: null,
        repo_path: r.path,
        base_commit: r.base_commit,
        head_commit: r.head_commit,
        risk: m.routing?.effective_risk || "medium",
        acceptance_test: null,
      };
    });
}

/** Which of an arm's overrides this mode and ticket can apply (the rest are reported). */
function unappliedFor(arm, ticket, mode) {
  const o = arm.overrides;
  const fx = ticket.source === "fixture" ? readJson(ticket.fixture) : {};
  const out = [];
  if ("scout" in o) out.push("scout (the experiment runner does not run the model scout)");
  if ("provider" in o && mode !== "live") out.push("provider (the stub agent runs in stub mode)");
  if ("memory" in o && !fx.memory) out.push("memory (the ticket carries no memory to prime)");
  if ("packet" in o && !Array.isArray(fx.scout))
    out.push("packet (the ticket carries no scout files)");
  if ("stub" in o && mode === "live") out.push("stub (live mode runs the real agent)");
  if (ticket.source === "manifest" && ("memory" in o || "context" in o || "packet" in o))
    out.push("prompt settings (a manifest keeps no prompt text)");
  return out;
}

export function plan(o) {
  const registry = loadRegistry();
  const arms = (o.arms || []).map((a) => parseArm(a, registry));
  if (arms.length < 2) throw new Error("an experiment needs at least two arms (--arm)");
  if (new Set(arms.map((a) => a.name)).size !== arms.length)
    throw new Error("arm names must differ");
  const mode = o.mode === "live" ? "live" : "stub";
  const only = o.only ? String(o.only).split(",").filter(Boolean) : null;
  let tickets;
  if (o.fixtures) tickets = fixtureTickets(resolve(o.fixtures), only);
  else if (o.manifests) {
    if (mode === "live")
      throw new Error(
        "live mode re-delivers fixtures only: a manifest keeps a hash of the prompt, not its text, so a recorded ticket cannot be re-prompted (stub mode replays its recorded change)",
      );
    tickets = manifestTickets(resolve(o.manifests), only, o.out);
  } else throw new Error("name the tickets: --fixtures <dir> or --manifests <dir>");
  const maxTickets = Number(o.maxTickets);
  if (Number.isInteger(maxTickets) && maxTickets > 0) tickets = tickets.slice(0, maxTickets);
  if (tickets.length === 0) throw new Error("no tickets to run");
  const seed = Number.isInteger(Number(o.seed)) ? Number(o.seed) >>> 0 : Date.now() >>> 0;
  const pairs = [];
  for (const t of tickets) for (const a of arms) pairs.push({ ticket: t.id, arm: a.name });
  const order = shuffle(pairs, seed).map((p, i) => ({ ...p, order: i + 1 }));
  const p = {
    schema: "gaffer.experiment-plan/1",
    mode,
    seed,
    baseline: arms[0].name,
    arms: arms.map((a) => ({
      ...a,
      unapplied: Object.fromEntries(tickets.map((t) => [t.id, unappliedFor(a, t, mode)])),
    })),
    tickets,
    order,
  };
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, "plan.json"), JSON.stringify(p, null, 2));
  return p;
}

const findT = (p, id) => {
  const t = p.tickets.find((x) => x.id === id);
  if (!t) throw new Error(`no ticket ${id} in the plan`);
  return t;
};
const findA = (p, name) => {
  const a = p.arms.find((x) => x.name === name);
  if (!a) throw new Error(`no arm ${name} in the plan`);
  return a;
};

/** The model flag for an arm: its model, else its tier's model, else the router's choice. */
export function modelFlag(p, ticketId, armName) {
  const t = findT(p, ticketId);
  const a = findA(p, armName);
  const reg = loadRegistry();
  let model = a.overrides.model || (a.overrides.tier ? reg.tiers[a.overrides.tier] : null);
  if (!model) model = routeModel({ phase: "implement", risk: t.risk, attempt: 1 }, reg).model;
  return model ? `--model ${model}` : "";
}

/**
 * The experiment's delivery brief. It is not the factory's rendered delivery prompt (that
 * needs the ticket in dispatch, which an offline run never touches): the task, the
 * acceptance criteria, the memory and scout blocks the arm turns on, and the rework
 * feedback on a later attempt.
 */
export function prompt(p, ticketId, armName, failure = "") {
  const t = findT(p, ticketId);
  const a = findA(p, armName);
  const fx = readJson(t.fixture);
  const o = a.overrides;
  const lines = [
    "You are delivering one change to the repository in the current directory. This is an offline experiment: nothing you do is recorded, landed or pushed.",
    "",
    `Task: ${fx.title || t.id}`,
  ];
  if (o.context !== "minimal") {
    const acs = Array.isArray(fx.acceptance) ? fx.acceptance : [];
    if (acs.length) {
      lines.push("", "Acceptance criteria:");
      for (const ac of acs) lines.push(`- ${String(ac.text || "")}`);
    }
    if (Array.isArray(fx.scout) && o.packet !== "0") {
      lines.push("", "Likely files (scout packet):");
      for (const f of fx.scout.slice(0, 20)) lines.push(`- ${String(f)}`);
    }
    if (typeof fx.memory === "string" && fx.memory && o.memory !== "off") {
      lines.push("", "Product memory:", fx.memory);
    }
  }
  lines.push(
    "",
    'Make the smallest change that meets the task, add or update a test, and commit it on the current branch. End your reply with a line starting "Smallest-change note:" that names the files you changed.',
  );
  if (failure)
    lines.push("", "The previous attempt failed this gate; fix it and commit again:", failure);
  return lines.join("\n");
}

/** The judge score a fixture records for its own delivery, when the run delivered it. */
export function judgeScore(p, ticketId, diffFile) {
  const t = findT(p, ticketId);
  if (t.source !== "fixture") return null;
  const fx = readJson(t.fixture);
  const dims = fx.judge?.reply?.dimensions;
  if (!Array.isArray(dims) || dims.length === 0) return null;
  let recorded;
  let ran;
  try {
    recorded = readFileSync(t.patch, "utf8");
    ran = readFileSync(diffFile, "utf8");
  } catch {
    return null;
  }
  const changed = (d) =>
    d
      .split("\n")
      .filter((l) => /^[+-](?![+-])/.test(l))
      .join("\n");
  if (!ran || changed(recorded) !== changed(ran)) return null;
  const scores = dims.map((d) => Number(d.score)).filter((n) => Number.isFinite(n));
  return scores.length
    ? Math.round((scores.reduce((s, n) => s + n, 0) / scores.length) * 100) / 100
    : null;
}

// Two-sided 95% t critical values by degrees of freedom (1..30); 1.96 above.
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];
const r4 = (v) => Math.round(v * 10000) / 10000;

/** Mean and a 95% t interval of paired differences; null interval below n = 2. */
export function pairedSummary(diffs) {
  const xs = diffs.filter((d) => typeof d === "number" && Number.isFinite(d));
  const n = xs.length;
  if (n === 0) return { n: 0, mean: null, ci95: null };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { n, mean: r4(mean), ci95: null };
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const t = n - 1 <= 30 ? T95[n - 2] : 1.96;
  const half = (t * sd) / Math.sqrt(n);
  return { n, mean: r4(mean), ci95: [r4(mean - half), r4(mean + half)] };
}

export const EXPERIMENT_LIMITS = [
  "the delivery brief is the experiment's own (task, acceptance criteria, the arm's memory and scout blocks), not the factory's rendered delivery prompt",
  "accepted means every gate passed and, where the ticket names one, its hidden acceptance test passed on the submitted head; no person reviewed it",
  "a judge score is shown only where a fixture records the rubric for its own delivery and the run delivered exactly that change",
  "stub mode proves the pipeline (worker seam, gates, pairing, report) for free; it says nothing about a model",
  "a run the caps stopped is left out of every pair, and the report says how many",
];

export function report(p, runs) {
  const byKey = new Map(runs.map((r) => [`${r.ticket}\u0000${r.arm}`, r]));
  const base = p.baseline;
  const comparisons = [];
  for (const a of p.arms) {
    if (a.name === base) continue;
    const b = p.arms.find((x) => x.name === base);
    const keys = [...new Set([...Object.keys(a.overrides), ...Object.keys(b.overrides)])].sort();
    const differs = keys.filter((k) => a.overrides[k] !== b.overrides[k]);
    const per = [];
    let excluded = 0;
    for (const t of p.tickets) {
      const ra = byKey.get(`${t.id}\u0000${a.name}`);
      const rb = byKey.get(`${t.id}\u0000${base}`);
      if (!ra || !rb || !ra.ran || !rb.ran) {
        excluded += 1;
        continue;
      }
      per.push({
        ticket: t.id,
        acceptance: (ra.accepted ? 1 : 0) - (rb.accepted ? 1 : 0),
        attempts: ra.attempts - rb.attempts,
        spend_usd:
          ra.spend_usd === null || rb.spend_usd === null ? null : r4(ra.spend_usd - rb.spend_usd),
        judge_score:
          ra.judge_score === null || rb.judge_score === null
            ? null
            : r4(ra.judge_score - rb.judge_score),
      });
    }
    const judge = pairedSummary(per.map((d) => d.judge_score));
    comparisons.push({
      arm: a.name,
      vs: base,
      n: per.length,
      excluded,
      differs_in: differs,
      overrides: a.overrides,
      acceptance: pairedSummary(per.map((d) => d.acceptance)),
      attempts: pairedSummary(per.map((d) => d.attempts)),
      spend_usd: {
        ...pairedSummary(per.map((d) => d.spend_usd)),
        unknown: per.filter((d) => d.spend_usd === null).length,
      },
      judge_score: judge.n ? judge : null,
      per_ticket: per,
    });
  }
  // The memory seam (evalLedger memoryLift.matched): two arms that differ only in memory.
  let memoryMatched = null;
  const mem = comparisons.find((c) => c.differs_in.length === 1 && c.differs_in[0] === "memory");
  if (mem) {
    const on = mem.overrides.memory === "on";
    const flip = (s) =>
      on || !s || s.mean === null
        ? s
        : { ...s, mean: -s.mean, ci95: s.ci95 ? [-s.ci95[1], -s.ci95[0]] : null };
    memoryMatched = {
      measure: "matched_memory_priming",
      mode: p.mode,
      tickets: mem.n,
      with_memory: on ? mem.arm : base,
      without_memory: on ? base : mem.arm,
      acceptance: flip(mem.acceptance),
      attempts: flip(mem.attempts),
      spend_usd: flip(mem.spend_usd),
      judge_score: mem.judge_score ? flip(mem.judge_score) : null,
    };
  }
  const spent = runs.reduce((s, r) => s + (typeof r.spend_usd === "number" ? r.spend_usd : 0), 0);
  return {
    schema: RESULTS_SCHEMA,
    mode: p.mode,
    seed: p.seed,
    baseline: base,
    arms: p.arms,
    tickets: p.tickets.map((t) => ({ id: t.id, source: t.source })),
    order: p.order,
    runs,
    spent_usd: r4(spent),
    stopped: runs.find((r) => r.skipped_reason)?.skipped_reason ?? null,
    comparisons,
    memory_matched: memoryMatched,
    limits: EXPERIMENT_LIMITS,
  };
}

const fmt = (s) =>
  !s || s.mean === null
    ? "n/a"
    : `${s.mean}${s.ci95 ? ` (95% CI ${s.ci95[0]} to ${s.ci95[1]})` : " (no interval below n=2)"}`;

export function markdown(res) {
  const out = [
    `# Matched experiment (${res.mode} mode)`,
    "",
    `Seed ${res.seed}. Baseline arm \`${res.baseline}\`. ${res.tickets.length} ticket(s), ${res.runs.length} run(s), $${res.spent_usd} spent.${res.stopped ? ` Stopped early: ${res.stopped}.` : ""}`,
    "",
    "| ticket | arm | order | attempts | submitted | accepted | spend | judge |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of [...res.runs].sort((a, b) =>
    a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : a.order - b.order,
  ))
    out.push(
      `| ${r.ticket} | ${r.arm} | ${r.order} | ${r.ran ? r.attempts : "not run"} | ${r.submitted ? "yes" : "no"} | ${r.accepted ? "yes" : "no"} | ${r.spend_usd === null ? "unknown" : `$${r.spend_usd}`} | ${r.judge_score ?? "n/a"} |`,
    );
  for (const c of res.comparisons) {
    out.push(
      "",
      `## ${c.arm} vs ${c.vs} (differs in: ${c.differs_in.join(", ") || "nothing"})`,
      "",
      `Paired over ${c.n} ticket(s)${c.excluded ? `, ${c.excluded} left out (a run did not run)` : ""}. A ticket an arm never submitted counts as that arm's failure.`,
      "",
      `- acceptance difference: ${fmt(c.acceptance)}`,
      `- attempts difference: ${fmt(c.attempts)}`,
      `- spend difference (USD): ${fmt(c.spend_usd)}${c.spend_usd.unknown ? `; ${c.spend_usd.unknown} pair(s) with an unknown spend left out` : ""}`,
      `- judge score difference: ${c.judge_score ? fmt(c.judge_score) : "no judge score on both arms"}`,
    );
  }
  out.push("", "## Limits", "", ...res.limits.map((l) => `- ${l}`), "");
  return out.join("\n");
}

function args(argv) {
  const o = { arms: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const v = argv[i + 1];
    i += 1;
    if (k === "arm") {
      o.arms.push(v);
      o.arm = v;
    } else o[k] = v;
  }
  return o;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const o = args(rest);
  switch (cmd) {
    case "plan": {
      const p = plan(o);
      process.stdout.write(
        `${p.tickets.length} ticket(s) x ${p.arms.length} arm(s), seed ${p.seed}, ${p.mode} mode\n`,
      );
      return 0;
    }
    case "pairs": {
      const p = readJson(o.plan);
      for (const x of p.order) process.stdout.write(`${x.order}\t${x.ticket}\t${x.arm}\n`);
      return 0;
    }
    case "ticket": {
      const t = findT(readJson(o.plan), o.ticket);
      const f = o.field;
      process.stdout.write(t[f] == null ? "" : String(t[f]));
      return 0;
    }
    case "arm-setting": {
      const a = findA(readJson(o.plan), o.arm);
      process.stdout.write(a.overrides[o.key] ?? "");
      return 0;
    }
    case "unapplied": {
      const a = findA(readJson(o.plan), o.arm);
      process.stdout.write(JSON.stringify(a.unapplied[o.ticket] ?? []));
      return 0;
    }
    case "prompt": {
      let failure = "";
      if (o.failure && existsSync(o.failure))
        failure = readFileSync(o.failure, "utf8").slice(0, 4000);
      process.stdout.write(prompt(readJson(o.plan), o.ticket, o.arm, failure));
      return 0;
    }
    case "model-flag":
      process.stdout.write(modelFlag(readJson(o.plan), o.ticket, o.arm));
      return 0;
    case "judge-score": {
      const s = judgeScore(readJson(o.plan), o.ticket, o.diff);
      process.stdout.write(s === null ? "" : String(s));
      return 0;
    }
    case "report": {
      const p = readJson(o.plan);
      const runs = existsSync(o.runs)
        ? readFileSync(o.runs, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
      const res = report(p, runs);
      writeFileSync(join(o.out, "results.json"), JSON.stringify(res, null, 2) + "\n");
      writeFileSync(join(o.out, "report.md"), markdown(res));
      for (const c of res.comparisons)
        process.stdout.write(
          `${c.arm} vs ${c.vs} over ${c.n} ticket(s): acceptance ${fmt(c.acceptance)} · attempts ${fmt(c.attempts)} · spend ${fmt(c.spend_usd)}\n`,
        );
      process.stdout.write(
        `results: ${join(o.out, "results.json")}\nreport:  ${join(o.out, "report.md")}\n`,
      );
      return 0;
    }
    default:
      process.stderr.write(`experiment.mjs: unknown command ${cmd}\n`);
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`experiment: ${e && e.message ? e.message : e}\n`);
    process.exit(2);
  }
}
