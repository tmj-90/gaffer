#!/usr/bin/env node
// runner/lib/json-tool.mjs — the runner's JSON helpers, on node.
//
// The runner is bash; its JSON reads used to be ~60 inline python3 programs
// (`python3 -c …`, heredocs) plus the `jget` one-liner. That made python3 a hard
// runtime dependency of a Node project and scattered the same parsing across
// files. Every one of those programs is now a subcommand here, byte-compatible
// with what it replaces (the context-primer renders are pinned to the checked-in
// goldens; the gate/evidence shapes to their tests). node is already required.
//
//   node json-tool.mjs expr '<js over d>'   stdin JSON → d; prints the result
//                       [--file <path>] [--default <text>]
//   node json-tool.mjs <subcommand> [args]  see the table below
//
// Output rules for `expr` (mirroring python's print): a string prints raw, a
// number/boolean as text, null/undefined as "" (the callers treat "", None and
// null alike), arrays/objects as JSON. A parse or evaluation failure exits 1 with
// nothing on stdout — the callers' `|| echo <default>` supplies the fallback —
// unless --default <text> is given, which prints it and exits 0.
//
// Fail-soft subcommands (the python they replace swallowed errors into an empty
// result) print nothing and exit 0 on bad input; fail-closed ones (dod-cmd-map,
// pick-unskipped without a skip file) exit non-zero exactly as before.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const [, , cmd, ...args] = process.argv;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
function parseStdin() {
  return JSON.parse(readStdin());
}
function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: undefined };
  }
}
function out(s) {
  process.stdout.write(s);
}
function println(s = "") {
  process.stdout.write(`${s}\n`);
}
/** python str(): None → "" here (callers normalise), True/False → "True"/"False". */
function pyStr(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}
function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Strip <untrusted-*> delimiter tokens so retrieval data cannot close an envelope. */
function sanitize(s) {
  return String(s ?? "").replace(/<\/?untrusted-[^>]*>/gi, "");
}
function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

switch (cmd) {
  // ── expr: the jget replacement ──────────────────────────────────────────────
  case "expr": {
    const dflt = flag("--default");
    const file = flag("--file"); // read the JSON from a file instead of stdin
    const expr = args[0] ?? "";
    let d;
    try {
      d = JSON.parse(file !== undefined ? readFileSync(file, "utf8") : readStdin());
    } catch {
      if (dflt !== undefined) {
        println(dflt);
        process.exit(0);
      }
      process.exit(1);
    }
    try {
      // The expression is the runner's own literal (never data), evaluated like `node -e`.
      const fn = new Function("d", "env", "argv", `"use strict"; return (${expr});`);
      const v = fn(d, process.env, args.slice(1));
      println(pyStr(v));
    } catch {
      if (dflt !== undefined) {
        println(dflt);
        process.exit(0);
      }
      process.exit(1);
    }
    break;
  }

  // ── selection helpers (tick.sh / clarify.sh / review.sh) ────────────────────
  // pick-unskipped <skip-file> [--all]: stdin = ticket list; numbers not in the
  // skip file, first only (default) or every one (--all). Missing skip file → exit 1
  // (the python raised on open()), matching the fail-closed callers.
  case "pick-unskipped": {
    const all = args.includes("--all");
    const skipFile = args.find((a) => a !== "--all");
    const skip = new Set(readFileSync(skipFile, "utf8").split(/\s+/).filter(Boolean));
    const d = parseStdin();
    const nums = (Array.isArray(d) ? d : [])
      .map((t) => String(t.number))
      .filter((n) => !skip.has(n));
    if (all) out(nums.join("\n"));
    else println(nums[0] ?? "");
    break;
  }
  // resume-pick <skip-file>: stdin = resume-requested list; first number not skipped,
  // "" when none. Unparseable stdin → "" (python: except → d=[]).
  case "resume-pick": {
    const skip = new Set(readFileSync(args[0], "utf8").split(/\s+/).filter(Boolean));
    const p = tryParse(readStdin());
    const d = p.ok && Array.isArray(p.value) ? p.value : [];
    const hit = d.find(
      (r) => r && r.number !== null && r.number !== undefined && !skip.has(String(r.number)),
    );
    println(hit ? String(hit.number) : "");
    break;
  }
  // numbers: stdin = ticket list → one number per line (skips null numbers). Bad JSON → nothing.
  case "numbers": {
    const p = tryParse(readStdin());
    const d = p.ok && Array.isArray(p.value) ? p.value : [];
    for (const t of d) {
      const n = (t ?? {}).number;
      if (n !== null && n !== undefined) println(String(n));
    }
    break;
  }
  // numbers-joined: stdin = ticket list → "1 2 3" (python raised on a missing number → exit 1).
  case "numbers-joined": {
    const p = tryParse(readStdin());
    const d = p.ok ? p.value : [];
    if (!Array.isArray(d)) process.exit(1);
    println(d.map((t) => String(t.number)).join(" "));
    break;
  }
  // ticket-status: stdin = ticket show → status or "" (fail-soft).
  case "ticket-status": {
    const p = tryParse(readStdin());
    try {
      const s = p.value.ticket.status;
      println(s === undefined ? "" : pyStr(s));
    } catch {
      println("");
    }
    break;
  }
  // repo-matches <target>: stdin = ticket show; exit 0 when any repository's local_path
  // or name equals target, else 1 (bad JSON → 1).
  case "repo-matches": {
    const target = args[0] ?? "";
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(1);
    const repos = (p.value && p.value.repositories) || [];
    const hit = repos.some(
      (r) => ((r && r.local_path) || "") === target || ((r && r.name) || "") === target,
    );
    process.exit(hit ? 0 : 1);
    break;
  }
  // branch-recorded <branch>: stdin = deliveries (array or {deliveries}); exit 0 when a
  // row's branch_name matches, 0 on unparseable input (fail SAFE: treat as recorded), else 1.
  case "branch-recorded": {
    const b = args[0] ?? "";
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(0);
    const d = p.value;
    const rows = Array.isArray(d) ? d : (d && d.deliveries) || [];
    process.exit(rows.some((r) => (r ?? {}).branch_name === b) ? 0 : 1);
    break;
  }

  // ── ac-checks.sh ─────────────────────────────────────────────────────────────
  // ac-check-rows: stdin = ticket show → "<ac-id>\t<check_command>\t<label>" per AC that
  // carries a check (TABs/newlines collapsed); exit 3 on unparseable input.
  case "ac-check-rows": {
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(3);
    const d = p.value || {};
    const acs = d.acceptanceCriteria || d.acceptance_criteria || [];
    acs.forEach((ac, idx) => {
      let cmd = String((ac && ac.check_command) || "").trim();
      if (!cmd) return;
      cmd = cmd.replace(/\t/g, " ").replace(/\n/g, " ").replace(/\r/g, " ");
      const text = String((ac && ac.text) || "")
        .replace(/\t/g, " ")
        .replace(/\n/g, " ")
        .slice(0, 60);
      println(`${pyStr((ac && ac.id) ?? "")}\t${cmd}\tAC${idx + 1}: ${text}`);
    });
    break;
  }

  // ── eval-judge.sh ───────────────────────────────────────────────────────────────
  // judge-input <diff-file> <tests-file>: env SHOW, FULL_BYTES, CAP → the judge's input
  // JSON (title + ACs from SHOW, the bounded diff with a truncation note, test output).
  case "judge-input": {
    const p = tryParse(process.env.SHOW || "{}");
    const d = p.ok && p.value ? p.value : {};
    const acs = [];
    (d.acceptanceCriteria || []).forEach((a, i) => {
      const text = String((a && a.text) || "").trim();
      if (text) acs.push({ id: String((a && a.id) || `AC${i + 1}`), text });
    });
    const readf = (f) => {
      try {
        return readFileSync(f).toString("utf8");
      } catch {
        return "";
      }
    };
    let diff = readf(args[0]);
    const full = Number.parseInt(process.env.FULL_BYTES || "0", 10) || 0;
    const cap = Number.parseInt(process.env.CAP || "0", 10) || 0;
    if (cap && full > cap) {
      diff += `\n\n[NOTE: delivery diff truncated to ${cap} of ${full} bytes — you are grading a PREFIX; treat unseen changes as ungraded, not absent.]`;
    }
    const tests = readf(args[1]).trim();
    const result = { ticketTitle: String(d.title || "").trim(), acceptanceCriteria: acs, diff };
    if (tests) result.testOutput = tests;
    println(JSON.stringify(result));
    break;
  }
  // judge-record: env VJ (verdict JSON), NUM, REPO, MEM, SPEND, JMODEL → the ledger record.
  case "judge-record": {
    const p = tryParse(process.env.VJ || "{}");
    const v = p.ok && isObj(p.value) ? p.value : {};
    v.ticketId = process.env.NUM || "";
    v.repo = process.env.REPO || "";
    v.memoryPresent = (process.env.MEM || "0") === "1";
    const spend = process.env.SPEND || "";
    if (spend) v.costUsd = spend; // "$0.1234" / "unknown" — the ledger CLI normalises/omits
    const jm = (process.env.JMODEL || "").trim();
    if (jm) v.judgeModel = jm;
    println(JSON.stringify(v));
    break;
  }

  // ── factory.config.sh: the typed prompt renderer's input JSON ─────────────────
  // prompt-inputs bootstrap|delivery|resume: env GF_* → one JSON line. The
  // reasons array is rebuilt from the "  - "-prefixed $_RF so the renderer
  // re-prefixes each to a block byte-identical to the bash path; a reason may span
  // lines (only its first carries the prefix), so continuations are grouped.
  case "prompt-inputs": {
    const e = process.env;
    const variant = args[0] ?? "delivery";
    if (variant === "bootstrap") {
      println(
        JSON.stringify({
          kind: "bootstrap",
          ticketNumber: e.GF_NUM ?? "",
          title: e.GF_TITLE ?? "",
          skills: e.GF_SKILLS ?? "",
          bootstrapDir: e.GF_DIR ?? "",
        }),
      );
      break;
    }
    const reasons = [];
    for (const l of (e.GF_RF ?? "").split("\n")) {
      if (l === "") continue;
      if (l.startsWith("  - ")) reasons.push(l.slice(4));
      else if (reasons.length) reasons[reasons.length - 1] += `\n${l}`;
      else reasons.push(l);
    }
    const writeRepos = [];
    for (const l of (e.GF_WT_ROWS ?? "").split("\n")) {
      if (l === "") continue;
      const cols = l.split("\t");
      writeRepos.push({
        worktreePath: cols.length > 4 ? cols[4] : "",
        name: cols.length > 1 ? cols[1] : "",
      });
    }
    const readRoots = (e.GF_READ_ROOTS ?? "").split("\n").filter((l) => l !== "");
    println(
      JSON.stringify({
        kind: "delivery",
        ticketNumber: e.GF_NUM ?? "",
        title: e.GF_TITLE ?? "",
        resuming: (e.GF_RESUMING ?? "false") === "true",
        skills: e.GF_SKILLS ?? "",
        lenses: e.GF_LENSES ?? "",
        reviewFeedbackReasons: reasons,
        fileCardsBlock: e.GF_FCB ?? "",
        productContextBlock: e.GF_PCB ?? "",
        workBranch: e.GF_WORK_BRANCH ?? "",
        writeRepos,
        readRoots,
        primaryRepo: e.GF_PRIMARY ?? "",
      }),
    );
    break;
  }

  // ── ticket-derived blocks (tick.sh) ─────────────────────────────────────────
  // distill-intent: env SHOW, DTITLE, DREPO, DNUM → one JSON line {title, summary}, or
  // nothing when the ticket has no acceptance criteria / unparseable SHOW.
  case "distill-intent": {
    const MAX_TITLE = 190;
    const MAX_SUMMARY = 780;
    const p = tryParse(process.env.SHOW || "{}");
    if (!p.ok) process.exit(0);
    const d = p.value || {};
    const acs = d.acceptanceCriteria || [];
    const lines = acs
      .map((a) => ((a && a.text) || "").trim())
      .filter((t) => t.length > 0)
      .map((t) => `- ${t}`);
    if (lines.length === 0) process.exit(0);
    const repo = process.env.DREPO || "";
    const num = process.env.DNUM || "";
    const title = process.env.DTITLE || "";
    const t = `Requirement from #${num}: ${title}`.slice(0, MAX_TITLE);
    let body =
      `Why '${repo}' ticket #${num} ("${title}") was built — the requirement it served ` +
      `(distilled at close from the delivered work):\n${lines.join("\n")}`;
    if (body.length > MAX_SUMMARY) body = `${body.slice(0, MAX_SUMMARY - 1)}…`;
    println(JSON.stringify({ title: t, summary: body }));
    break;
  }
  // partition: stdin = ticket show → the three @@-marked sections tick.sh slices.
  case "partition": {
    const d = parseStdin();
    const ACTIVE = new Set(["confirmed", "implicit_single_repo"]);
    const writePaths = [];
    const readPaths = [];
    const writeRows = [];
    for (const r of d.repositories || []) {
      const p = ((r && r.local_path) || "").trim();
      const access = (r && r.access) || "";
      const relation = (r && r.relation) || "";
      if (relation === "suggested" || relation === "rejected") continue;
      if (access === "none") continue;
      const isWrite = ACTIVE.has(relation) && access === "write";
      if (isWrite) {
        if (p) {
          writePaths.push(p);
          writeRows.push([r.id || "", r.name || "", p, r.default_branch || "main"].join("\t"));
        }
      } else if (p) readPaths.push(p);
    }
    println("@@WRITE_PATHS@@");
    println(writePaths.join("\n"));
    println("@@READ_PATHS@@");
    println(readPaths.join("\n"));
    println("@@WRITE_ROWS@@");
    println(writeRows.join("\n"));
    break;
  }
  // dod-cmd-map: stdin = ticket show → sentinel + "key\ttest\tlint" rows; exit 3 on a
  // parse failure (no sentinel → the caller fails CLOSED).
  case "dod-cmd-map": {
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(3);
    const d = p.value || {};
    println("@@DOD_PARSE_OK@@");
    for (const r of d.repositories || []) {
      const key = ((r && (r.id || r.name)) || "").trim();
      if (!key) continue;
      const tc = ((r && r.test_command) || "").replace(/\t/g, " ").replace(/\n/g, " ");
      const lc = ((r && r.lint_command) || "").replace(/\t/g, " ").replace(/\n/g, " ");
      println([key, tc, lc].join("\t"));
    }
    break;
  }
  // smallest-change-note: stdin = ticket show → the MOST RECENT evidence text carrying a
  // "smallest change" marker, or "". Only evidence rows count: an agent's note can only
  // arrive as evidence, while events carry runner text (a rework event's payload says
  // "record a smallest-change note", which must never pass as the note). The runner's
  // own "needs_human_review: missing smallest-change note" flag rows are skipped too: on
  // a rework they would otherwise shadow the agent's fresh note for the new diff.
  case "smallest-change-note": {
    const p = tryParse(readStdin());
    const d = p.ok && p.value ? p.value : {};
    const pat = /smallest[ -]change/i;
    const runnerFlag = /^\s*needs_human_review\b/i;
    const pick = (texts) => texts.filter((s) => pat.test(s) && !runnerFlag.test(s)).pop();
    const fromEvidence = pick(
      (d.evidence || []).map((e) =>
        ["summary", "description", "type"].map((k) => pyStr((e ?? {})[k] ?? "")).join(" "),
      ),
    );
    println(fromEvidence ?? "");
    break;
  }
  // review-feedback: stdin = ticket show → "  - <reason>" lines for the last five
  // distinct rework reasons (transitions to refining/ready/cancelled, boilerplate
  // reasons dropped). Unparseable → nothing.
  case "review-feedback": {
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(0);
    const d = p.value || {};
    const outList = [];
    const skip = new Set([
      "review_rejected",
      "mark ready",
      "reopen",
      "reopen for review",
      "board_move",
      "wont_do",
    ]);
    for (const e of d.events || []) {
      if (!e || e.event_type !== "ticket.transitioned") continue;
      let pl;
      try {
        pl = JSON.parse(e.payload_json || "{}");
      } catch {
        pl = {};
      }
      if (!isObj(pl)) pl = {};
      if (["refining", "ready", "cancelled"].includes(pl.to)) {
        const r = String(pl.reason || "").trim();
        const lc = r.toLowerCase();
        if (r && !skip.has(lc) && !lc.startsWith("reopen")) outList.push(r);
      }
    }
    const seen = new Set();
    const uniq = outList.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
    for (const r of uniq.slice(-5)) println(`  - ${r}`);
    break;
  }
  // worktree-rows-json: stdin = TAB rows (id name path base wt) → JSON array of the
  // rows that have a worktree.
  case "worktree-rows-json": {
    const rows = [];
    for (const ln of readStdin().split("\n")) {
      const parts = ln.replace(/\n$/, "").split("\t");
      if (parts.length >= 5 && parts[4])
        rows.push({ repo: parts[1], path: parts[2], base: parts[3], wt: parts[4] });
    }
    println(JSON.stringify(rows));
    break;
  }

  // ── greenfield.sh ────────────────────────────────────────────────────────────
  // bootstrap-repo-name: stdin = ticket show → filesystem-safe slug ("" on bad JSON).
  case "bootstrap-repo-name": {
    const p = tryParse(readStdin());
    if (!p.ok) {
      println("");
      process.exit(0);
    }
    const d = p.value || {};
    const t = d.ticket || {};
    const repos = d.repositories || [];
    let name;
    if (repos.length && ((repos[0] && repos[0].name) || "").trim()) name = repos[0].name.trim();
    else if ((t.source || "").trim()) name = t.source.trim();
    else name = (t.title || "").trim();
    let slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    slug = slug
      .replace(/-+/g, "-")
      .slice(0, 64)
      .replace(/^-+|-+$/g, "");
    println(slug);
    break;
  }
  case "inherit-links": {
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(0);
    for (const l of (p.value && p.value.links) || []) {
      const t = l && l.ticket;
      const r = l && l.repo;
      if (t && r) println([pyStr(t), pyStr(r), pyStr(l.reason ?? "")].join("\t"));
    }
    break;
  }
  case "inherit-amb-count": {
    const p = tryParse(readStdin());
    if (!p.ok) {
      println("0");
      process.exit(0);
    }
    println(String(((p.value && p.value.ambiguous) || []).length));
    break;
  }
  case "inherit-amb-field": {
    const i = Number.parseInt(args[0] ?? "0", 10);
    const field = args[1] ?? "";
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(0);
    const amb = (p.value && p.value.ambiguous) || [];
    if (i >= amb.length) process.exit(0);
    const a = amb[i] || {};
    if (field === "ticket") println(pyStr(a.ticket ?? ""));
    else if (field === "candidates")
      for (const c of a.candidates || []) if (c && c.repo) println(pyStr(c.repo));
    break;
  }
  case "inherit-amb-bin": {
    const i = Number.parseInt(args[0] ?? "0", 10);
    const d = parseStdin();
    println(pyStr(((d.ambiguous || [])[i] || {}).claudeBin ?? "claude"));
    break;
  }
  case "inherit-amb-argv": {
    const i = Number.parseInt(args[0] ?? "0", 10);
    const d = parseStdin();
    for (const tok of ((d.ambiguous || [])[i] || {}).argv || []) out(`${pyStr(tok)}\0`);
    break;
  }

  // ── dod.sh ────────────────────────────────────────────────────────────────────
  // dod-evidence-summary <results-file> <PASS|FAIL>: the JSON line the dashboard parses,
  // then the human transcript and the failing output blocks, verbatim.
  case "dod-evidence-summary": {
    const [results, overall] = args;
    let text;
    try {
      text = readFileSync(results, "utf8");
    } catch {
      text = "";
    }
    const gates = [];
    const lines = [];
    const splitLines = text.split(/\r\n|\r|\n/);
    if (splitLines.length && splitLines[splitLines.length - 1] === "") splitLines.pop();
    for (const ln of splitLines) {
      const parts = ln.split("\t");
      if (parts[0] === "GATE" && parts.length >= 6) {
        const [, gate, repo, status, rc, note] = parts;
        gates.push({ gate, repo, status, rc, note });
        lines.push(`  [${status}] ${gate} (${repo}) — ${note}`);
      }
    }
    const tail = [];
    let keep = false;
    for (const ln of splitLines) {
      if (ln.startsWith("---DOD-OUTPUT ")) {
        keep = true;
        tail.push(ln);
      } else if (ln.startsWith("---END-DOD-OUTPUT---")) {
        tail.push(ln);
        keep = false;
      } else if (keep) tail.push(ln);
    }
    const result = [`DoD: ${overall}`, JSON.stringify({ dod: overall, gates }), "", ...lines];
    if (tail.length) result.push("", ...tail);
    out(result.join("\n"));
    break;
  }

  // ── pr-create.sh ───────────────────────────────────────────────────────────────
  // pr-body <ticket-number>: reads the ticket through the dispatch CLI and renders the
  // PR body; any failure prints the one-line fallback.
  case "pr-body": {
    const num = args[0] ?? "";
    const fallback = () => {
      println(`Delivered ticket #${num}`);
      process.exit(0);
    };
    const wgCli = path.join(
      process.env.RUNNER_DIR || "",
      "..",
      "packages",
      "dispatch",
      "dist",
      "cli",
      "index.js",
    );
    const db = process.env.DISPATCH_DB || "";
    if (!process.env.RUNNER_DIR || !db) fallback();
    let d;
    try {
      const raw = execFileSync(
        "node",
        [wgCli, "--db", db, "ticket", "show", num, "--format", "json"],
        {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10_000,
        },
      );
      d = JSON.parse(String(raw));
    } catch {
      fallback();
    }
    const ticket = d.ticket || {};
    const acs = d.acceptanceCriteria || [];
    const evidence = d.evidence || [];
    const lines = [`## Ticket #${num}: ${pyStr(ticket.title ?? "")}`, ""];
    if (acs.length) {
      lines.push("### Acceptance Criteria");
      for (const ac of acs) {
        const status = ac.status ?? "pending";
        const mark = ["done", "passed", "verified"].includes(status) ? "x" : " ";
        lines.push(`- [${mark}] ${pyStr(ac.text ?? "")}`);
      }
      lines.push("");
    }
    if (evidence.length) {
      lines.push("### Evidence");
      const diff = [];
      const tests = [];
      const other = [];
      for (const ev of evidence) {
        const t = ev.evidenceType || ev.evidence_type || "";
        const s = String(ev.summary || "").trim();
        if (!s) continue;
        if (t === "diff_summary") diff.push(s);
        else if (t === "test_output" || t === "lint_output") tests.push(s);
        else other.push(s);
      }
      for (const block of [...diff, ...tests, ...other])
        lines.push("", "```", block.slice(0, 2000), "```");
      lines.push("");
    }
    lines.push("---", "*Delivered by Gaffer factory agent.*");
    println(lines.join("\n"));
    break;
  }

  // ── context-primer.sh (renders pinned to the checked-in goldens) ───────────────
  // diagnostics-warn: stdin = packet → one WARN line per diagnostic on stderr.
  case "diagnostics-warn": {
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(0);
    for (const d of (p.value && p.value.diagnostics) || [])
      process.stderr.write(`WARN[file-cards]: ${pyStr(d)}\n`);
    break;
  }
  case "context-file-cards": {
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(0);
    const pk = p.value || {};
    const cards = pk.cards || [];
    const order = {};
    for (const e of pk.selectionOrder || []) {
      if (!("path" in e) || !("tier" in e)) process.exit(1); // python KeyError → non-zero
      order[e.path] = e.tier;
    }
    const dg = pk.digest;
    const lines = [];
    if (dg && dg.overview) lines.push(`Repo digest: ${sanitize(dg.overview).trim()}`);
    for (const c of cards) {
      const tier = Object.prototype.hasOwnProperty.call(order, c.path) ? order[c.path] : "fts";
      let head = `  - [${pyStr(tier)}] ${sanitize(c.path ?? "")}`;
      if (c.tldr) head += ` — ${sanitize(c.tldr).trim()}`;
      lines.push(head);
      const syms = c.symbols || [];
      if (syms.length)
        lines.push(
          `      symbols: ${syms
            .slice(0, 8)
            .map((s) => sanitize(s))
            .join(", ")}`,
        );
    }
    const cov = pk.coverage || {};
    const missing = cov.missing || [];
    const tr = pk.truncationReason;
    const foot = [];
    if (missing.length)
      foot.push(
        `no card yet for: ${missing
          .slice(0, 8)
          .map((s) => sanitize(s))
          .join(", ")}`,
      );
    if (tr) foot.push(sanitize(tr));
    if (!lines.length) process.exit(0);
    println(lines.join("\n"));
    if (foot.length) println(`  (${foot.join("; ")})`);
    break;
  }
  case "context-primed": {
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(0);
    const pk = p.value || {};
    const paths = (pk.cards || []).map((c) => c.path ?? "").filter(Boolean);
    const digest = Boolean(pk.digest);
    if (!paths.length && !digest) process.exit(0);
    let head = `${paths.length} card${paths.length === 1 ? "" : "s"}: ${paths.slice(0, 8).join(", ")}`;
    if (paths.length > 8) head += `, +${paths.length - 8} more`;
    println(`${digest ? "repo-digest + " : ""}${head}`);
    break;
  }
  case "context-product": {
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(0);
    const rows = p.value;
    if (!Array.isArray(rows) || !rows.length) process.exit(0);
    const lines = [];
    for (const r of rows) {
      const kind = sanitize(r.kind ?? "").trim() || "other";
      const title = sanitize(r.title ?? "").trim();
      const summ = sanitize(r.summary ?? "").trim();
      let head = `  - [${kind}] ${title}`;
      if (summ) head += ` — ${summ}`;
      lines.push(head);
    }
    if (!lines.length) process.exit(0);
    println(lines.join("\n"));
    break;
  }

  // ── quarantine.sh ───────────────────────────────────────────────────────────────
  // quarantine <tag> <single|block>: wrap stdin in <untrusted-TAG> after neutralising
  // any smuggled delimiter for that tag; `single` collapses whitespace to one line.
  case "quarantine": {
    const [tag, mode] = args;
    let data = readStdin();
    const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    data = data.replace(new RegExp(`</?\\s*untrusted-${esc}\\s*>`, "gi"), "");
    if (mode === "single") data = data.replace(/\s+/g, " ").trim();
    out(`<untrusted-${tag}>${data}</untrusted-${tag}>`);
    break;
  }

  // ── gaffer / status.sh / loop.sh ────────────────────────────────────────────────
  // eval-summary: stdin = evalLedgerCli summarize JSON → the human table `gaffer eval` prints.
  case "eval-summary": {
    const s = parseStdin();
    const pct = (x) => `${Math.round(100 * x)}%`;
    const { memoryLift: lift, cost } = s;
    println(
      `deliveries judged   ${s.count}   (pass ${pct(s.passRate)} / blocking ${pct(s.blockRate)})`,
    );
    println(`mean score          ${s.meanScore}/5`);
    const dims = s.dimensionMeans || {};
    if (Object.keys(dims).length)
      println(
        `dimensions          ${Object.entries(dims)
          .map(([k, v]) => `${k} ${v}`)
          .join("  ")}`,
      );
    const l = lift.lift;
    const wm = lift.withMemory;
    const wo = lift.withoutMemory;
    const arms = `with-memory ${wm.meanScore}/5 (n=${wm.count}) vs without ${wo.meanScore}/5 (n=${wo.count})`;
    const lstr =
      l !== null && l !== undefined
        ? `${l >= 0 ? "+" : ""}${Number(l).toFixed(2)}`
        : "n/a (need both arms)";
    println(`memory lift         ${lstr}   ${arms}`);
    if (cost.costedCount) {
      const cpp = cost.costPerPass;
      const tail =
        cpp !== null && cpp !== undefined ? `$${cpp}/passing delivery` : "no costed passes yet";
      println(
        `cost                $${cost.totalCostUsd} over ${cost.costedCount} costed / $${cost.meanCostUsd} mean / ${tail}`,
      );
    }
    break;
  }
  // status-count <status>: stdin = stats JSON → ticketsByStatus[status] (0 when absent).
  case "status-count": {
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(1);
    const by = (p.value && p.value.ticketsByStatus) || {};
    // ACCEPTANCE GATE: `acceptance_unaccepted` = epics whose implementation has fully
    // merged but whose build is NOT accepted (stats.acceptance.unaccepted).
    if (args[0] === "acceptance_unaccepted")
      println(pyStr(Math.trunc(Number(((p.value || {}).acceptance || {}).unaccepted || 0))));
    else println(pyStr(by[args[0]] ?? 0));
    break;
  }
  // status-acceptance-rows: one TSV row per epic from stats.acceptance.epics —
  // name \t result \t acceptance ticket \t accepted commit \t repo path \t default branch.
  case "status-acceptance-rows": {
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(0);
    const epics = (((p.value || {}).acceptance || {}).epics || []).filter(Boolean);
    const clean = (v) => String(v ?? "").replace(/[\t\n\r]/g, " ");
    for (const e of epics)
      println(
        [
          e.epic_name,
          e.result,
          e.acceptance_ticket ?? "?",
          e.accepted_commit ?? "",
          e.repo_path ?? "",
          e.default_branch ?? "",
        ]
          .map(clean)
          .join("\t"),
      );
    break;
  }
  // loop-count in_review|blocked|decisions: the integers loop.sh's closing ping reads.
  case "loop-count": {
    const p = tryParse(readStdin());
    if (!p.ok) {
      println("0");
      process.exit(0);
    }
    const q = p.value || {};
    if (args[0] === "decisions")
      println(String((q.items || []).filter((i) => i && i.kind === "decision").length));
    else if (args[0] === "acceptance_unaccepted")
      println(String(Math.trunc(Number((q.acceptance || {}).unaccepted || 0))));
    else println(String(Math.trunc(Number((q.ticketsByStatus || {})[args[0]] || 0))));
    break;
  }
  // status-hq-lines: stdin = human-queue JSON → "    #N  reason" per pending decision.
  case "status-repo-lines": {
    // `dispatch repo list` JSON → one line per registered repo for the status pane:
    //     <name>  <local_path or remote>  [<default_branch>] <stack>  gates: test ✓/–  lint ✓/–
    const p = tryParse(readStdin());
    if (!p.ok || !Array.isArray(p.value)) process.exit(0);
    for (const r of p.value) {
      if (!r || typeof r.name !== "string") continue;
      const where = r.local_path || r.remote_url || "(no path)";
      const gates = `test ${r.test_command ? "✓" : "–"}  lint ${r.lint_command ? "✓" : "–"}`;
      println(
        `    ${r.name}  ${where}  [${r.default_branch || "?"}] ${r.stack || "?"}  gates: ${gates}`,
      );
    }
    break;
  }
  case "status-hq-lines": {
    const p = tryParse(readStdin());
    if (!p.ok) process.exit(0);
    for (const i of (p.value && p.value.items) || []) {
      if (!i || i.kind !== "decision") continue;
      const t = i.ticket;
      const ref = t && t.number !== null && t.number !== undefined ? `#${t.number}` : "-";
      const reason = String(i.reason || "")
        .split(/\s+/)
        .filter(Boolean)
        .join(" ");
      println(`    ${ref}  ${reason}`);
    }
    break;
  }

  // ── run-summary.sh ───────────────────────────────────────────────────────────────
  // summary-blocks <ledger>: the safety-hook block report (env SUMMARY_SINCE scopes it).
  case "summary-blocks": {
    const since = process.env.SUMMARY_SINCE || "";
    const cats = {};
    let total = 0;
    let secret = 0;
    for (const raw of readFileSync(args[0], "utf8").split("\n")) {
      const ln = raw.trim();
      if (!ln) continue;
      let e;
      try {
        e = JSON.parse(ln);
      } catch {
        continue;
      }
      if (since && pyStr(e.ts ?? "") < since) continue;
      total += 1;
      const c = e.category ?? "other";
      cats[c] = (cats[c] || 0) + 1;
      if (c === "secret-read") secret += 1;
    }
    const scope = since ? "this run" : "(all-time)";
    if (total === 0) println(`    \x1b[1;32m✓\x1b[0m nothing blocked ${scope}`);
    else {
      println(`    \x1b[1;33m${total}\x1b[0m attempt(s) blocked ${scope} — every one stopped:`);
      for (const [c, n] of Object.entries(cats).sort((a, b) => b[1] - a[1]))
        println(`      ${String(c).padEnd(22)} ${n}`);
      if (secret)
        println(`    \x1b[1;31m!\x1b[0m ${secret} secret-read attempt(s) blocked — worth a glance`);
    }
    break;
  }
  // summary-usage <ledger>: the honest usage report (billed tokens, model split, relayed cost).
  case "summary-usage": {
    const since = process.env.SUMMARY_SINCE || "";
    const asNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const hum = (n) => {
      n = Number(n);
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
      return String(Math.trunc(n));
    };
    let measured = 0;
    let unknown = 0;
    let tokIn = 0;
    let tokOut = 0;
    let tokCacheR = 0;
    let tokCacheC = 0;
    let costTotal = 0;
    let costAny = false;
    const split = { "opus-plan": 0, "sonnet-impl": 0, other: 0 };
    for (const raw of readFileSync(args[0], "utf8").split("\n")) {
      const ln = raw.trim();
      if (!ln) continue;
      let e;
      try {
        e = JSON.parse(ln);
      } catch {
        continue;
      }
      if (since && pyStr(e.ts ?? "") < since) continue;
      if (e.measured === true) measured += 1;
      else {
        unknown += 1;
        continue;
      }
      const models = e.models;
      if (isObj(models)) {
        for (const [model, mu] of Object.entries(models)) {
          if (!isObj(mu)) continue;
          const mi = asNum(mu.input);
          const mo = asNum(mu.output);
          const mr = asNum(mu.cache_read);
          const mc = asNum(mu.cache_create);
          if (mi) tokIn += mi;
          if (mo) tokOut += mo;
          if (mr) tokCacheR += mr;
          if (mc) tokCacheC += mc;
          const mlc = String(model || "").toLowerCase();
          const vol = (mi || 0) + (mo || 0);
          if (mlc.includes("opus")) split["opus-plan"] += vol;
          else if (mlc.includes("sonnet")) split["sonnet-impl"] += vol;
          else split.other += vol;
        }
      }
      const c = asNum(e.total_cost_usd);
      if (c !== null) {
        costTotal += c;
        costAny = true;
      }
    }
    const scope = since ? "this run" : "(all-time)";
    const totalCalls = measured + unknown;
    if (totalCalls === 0) println(`    \x1b[1;32m✓\x1b[0m no agent calls recorded ${scope}`);
    else {
      if (unknown)
        println(
          `    \x1b[1;33m${measured} measured, ${unknown} unknown\x1b[0m ${scope} — 'unknown' = unmeasurable (timeout/crash/no-usage), NOT zero`,
        );
      else println(`    ${measured} call(s) measured, 0 unknown ${scope}`);
      if (measured === 0)
        println(
          `    nothing measurable ${scope} — every agent call was unmeasured; no token/cost figure can be honestly reported`,
        );
      else {
        const billed = tokIn + tokOut + tokCacheR + tokCacheC;
        println(
          `    billed tokens: ~${hum(billed)}  (in ${hum(tokIn)} · out ${hum(tokOut)} · cache-read ${hum(tokCacheR)} · cache-write ${hum(tokCacheC)})`,
        );
        if (billed > 0) {
          const shareR = (100 * tokCacheR) / billed;
          if (shareR >= 50)
            println(
              `    \x1b[2mcost is dominated by cache-read (${Math.round(shareR)}% of billed): the agent re-reads its cached context each turn\x1b[0m`,
            );
        }
        const totVol = Object.values(split).reduce((a, b) => a + b, 0) || 1;
        println("    model split (plan vs impl, by in+out tokens):");
        for (const label of ["opus-plan", "sonnet-impl", "other"]) {
          const v = split[label];
          if (v)
            println(
              `      ${label.padEnd(14)} ${Math.trunc(v)} tokens (${Math.round((100 * v) / totVol)}%)`,
            );
        }
        if (costAny) {
          println(`    API-equivalent cost (Claude Code's own figure): $${costTotal.toFixed(4)}`);
          println(
            "    \x1b[2mnote: on a Max/Pro subscription the marginal cost is the flat plan fee, not this number\x1b[0m",
          );
        } else println("    API-equivalent cost: unknown (Claude Code reported no cost figure)");
      }
    }
    break;
  }

  // ── sandbox*.sh ───────────────────────────────────────────────────────────────────
  case "realpath": {
    println(realpathSync(args[0]));
    break;
  }

  default:
    process.stderr.write(`json-tool: unknown subcommand '${cmd ?? ""}'\n`);
    process.exit(2);
}
