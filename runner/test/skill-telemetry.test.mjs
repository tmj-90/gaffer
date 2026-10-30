#!/usr/bin/env node
// Tests for the skill-selection telemetry writer (bin/record-skill-usage.mjs):
// it records which skills were SELECTED per delivery and, best-effort, which were
// APPLIED (detected in the agent's output). Run: node test/skill-telemetry.test.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseList,
  detectApplied,
  buildRecord,
  recordFromOpts,
  detectOpened,
  mountedNames,
  recordSkillUsage,
} from "../bin/record-skill-usage.mjs";

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`,
  );
}

// --- parseList --------------------------------------------------------------
check("parseList splits comma/space and de-dupes, order preserved", () => {
  eq(
    parseList("run-tests, run-lint ,run-tests\nminimalism"),
    ["run-tests", "run-lint", "minimalism"],
    "list",
  );
  eq(parseList(""), [], "empty");
  eq(parseList(undefined), [], "undefined");
});

// --- detectApplied ----------------------------------------------------------
check("detectApplied marks a selected skill applied when its name appears", () => {
  const applied = detectApplied(
    ["run-tests", "run-lint", "frontend-component"],
    "I used the run-tests skill; frontend-component too.",
  );
  eq(applied, ["run-tests", "frontend-component"], "applied");
});
check("detectApplied is word-boundary safe (no substring false positives)", () => {
  // "run-tests-extra" must NOT match the selected "run-tests".
  eq(detectApplied(["run-tests"], "ran the run-tests-extra helper"), [], "no substring match");
});
check("detectApplied matches the space-separated form + is case-insensitive (prose)", () => {
  // Agents narrate in prose, not slugs — the old slug-only, case-sensitive match missed these.
  eq(detectApplied(["run-tests"], "I then run tests to verify"), ["run-tests"], "space form");
  eq(detectApplied(["self-review"], "Did a Self Review pass"), ["self-review"], "capitalised");
  // …but a longer hyphenated token still must not false-match the slug.
  eq(detectApplied(["run-tests"], "run-tests-extra only"), [], "still boundary-safe");
});
check("detectApplied returns [] for empty output", () => {
  eq(detectApplied(["run-tests"], ""), [], "empty output");
});

// --- buildRecord ------------------------------------------------------------
check("buildRecord captures selected/applied/count and an ISO ts", () => {
  const r = buildRecord({
    ticket: "42",
    role: "delivery",
    stack: "typescript",
    selected: ["a", "b"],
    applied: ["a"],
  });
  eq(r.selected, ["a", "b"], "selected");
  eq(r.applied, ["a"], "applied");
  eq(r.count, 2, "count");
  eq(r.ticket, "42", "ticket");
  assert(!Number.isNaN(Date.parse(r.ts)), "ts is a valid date");
});

// --- recordFromOpts (with scan-file applied detection) ----------------------
check("recordFromOpts reads --scan and unions explicit + scanned applied", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-telem-"));
  try {
    const scan = join(dir, "out.json");
    writeFileSync(
      scan,
      JSON.stringify({ result: "used run-tests then the record-evidence skill" }),
    );
    const rec = recordFromOpts({
      ticket: "7",
      role: "delivery",
      stack: "typescript",
      selected: "run-tests, run-lint, record-evidence",
      applied: "run-lint",
      scan,
    });
    eq(rec.selected, ["run-tests", "run-lint", "record-evidence"], "selected recorded");
    // explicit run-lint + scanned run-tests + record-evidence (both in text)
    eq(rec.applied, ["run-lint", "run-tests", "record-evidence"], "applied union");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("recordFromOpts tolerates a missing scan file (fail-soft)", () => {
  const rec = recordFromOpts({ selected: "run-tests", scan: "/no/such/file.json" });
  eq(rec.selected, ["run-tests"], "selected still recorded");
  eq(rec.applied, [], "applied empty when scan unreadable");
});

// --- end-to-end CLI append --------------------------------------------------
check("CLI appends one JSONL record per delivery to --out", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-telem-cli-"));
  try {
    const out = join(dir, "telemetry.jsonl");
    const bin = new URL("../bin/record-skill-usage.mjs", import.meta.url).pathname;
    const run = (selected) =>
      spawnSync(
        process.execPath,
        [
          bin,
          "--ticket",
          "1",
          "--role",
          "delivery",
          "--stack",
          "ts",
          "--selected",
          selected,
          "--out",
          out,
        ],
        { encoding: "utf8" },
      );
    run("run-tests, minimalism");
    run("run-lint");
    const lines = readFileSync(out, "utf8").trim().split("\n");
    eq(lines.length, 2, "two records appended");
    const first = JSON.parse(lines[0]);
    eq(first.selected, ["run-tests", "minimalism"], "first record's selected");
    eq(first.role, "delivery", "role recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- what was MOUNTED, and what the agent OPENED -----------------------------
check("recordFromOpts counts the mount's names as selected (universal set included)", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-telem-mount-"));
  try {
    for (const n of ["run-tests", "plan-change", "add-api-endpoint"]) mkdirSync(join(dir, n));
    const rec = recordFromOpts({ selected: "add-api-endpoint", mount: dir });
    eq(rec.selected, ["add-api-endpoint", "plan-change", "run-tests"], "selection ∪ mount");
    eq(mountedNames("/no/such/mount"), [], "unreadable mount → []");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ledger = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
check("detectOpened: a Read of .claude/skills/<name>/ in THIS run counts as applied", () => {
  const text = ledger([
    // before the run started → ignored
    {
      ts: "2026-01-01T09:59:59.000Z",
      ticket: "7",
      tool: "Read",
      target: "/wt/7/.claude/skills/run-lint/SKILL.md",
    },
    // this delivery (ticket match), absolute Read
    {
      ts: "2026-01-01T10:00:01.500Z",
      ticket: "7",
      tool: "Read",
      target: "/wt/7/.claude/skills/run-tests/SKILL.md",
    },
    // this delivery, a Bash cat with a relative path
    {
      ts: "2026-01-01T10:00:02.000Z",
      ticket: "7",
      tool: "Bash",
      target: "cat .claude/skills/self-review/SKILL.md",
    },
    // another ticket's agent → ignored
    {
      ts: "2026-01-01T10:00:03.000Z",
      ticket: "8",
      tool: "Read",
      target: "/wt/8/.claude/skills/minimalism/SKILL.md",
    },
    // a ticketless reviewer in its own worktree root → counted when the root matches
    {
      ts: "2026-01-01T10:00:04.000Z",
      ticket: null,
      tool: "Read",
      target: "/data/worktrees/review-7/.claude/skills/review-ticket/SKILL.md",
    },
    // an unselected skill → never invented
    {
      ts: "2026-01-01T10:00:05.000Z",
      ticket: "7",
      tool: "Read",
      target: "/wt/7/.claude/skills/seo-audit/SKILL.md",
    },
    "not json",
  ]);
  const sel = ["run-tests", "run-lint", "self-review", "minimalism", "review-ticket"];
  eq(
    detectOpened(sel, text, { ticket: "7", since: "2026-01-01T10:00:00Z" }),
    ["run-tests", "self-review"],
    "delivery (ticket-scoped)",
  );
  eq(
    detectOpened(sel, text, {
      since: "2026-01-01T10:00:00Z",
      roots: ["/data/worktrees/review-7"],
    }),
    ["review-ticket"],
    "reviewer (root-scoped, no ticket)",
  );
  eq(detectOpened(sel, "", { ticket: "7" }), [], "no ledger → nothing");
});
check("detectOpened: a root matches on a path boundary, never as a bare prefix", () => {
  const at = "2026-01-01T10:00:01.000Z";
  const text = ledger([
    // a concurrent ticketless agent on ticket 71 / 7NN → must NOT be credited to root review-7
    {
      ts: at,
      ticket: null,
      tool: "Read",
      target: "/x/review-71/.claude/skills/security-review/SKILL.md",
    },
    {
      ts: at,
      ticket: null,
      tool: "Read",
      target: "/x/review-700/.claude/skills/run-tests/SKILL.md",
    },
    {
      ts: at,
      ticket: null,
      tool: "Bash",
      target: "cat /x/review-7x/.claude/skills/run-lint/SKILL.md",
    },
    // the same root nested under another prefix is a different path
    {
      ts: at,
      ticket: null,
      tool: "Read",
      target: "/other/x/review-7/.claude/skills/minimalism/SKILL.md",
    },
    // the run's own root: absolute Read, and a Bash `cd <root> && cat …`
    {
      ts: at,
      ticket: null,
      tool: "Read",
      target: "/x/review-7/.claude/skills/review-ticket/SKILL.md",
    },
    {
      ts: at,
      ticket: null,
      tool: "Bash",
      target: "cd /x/review-7 && cat .claude/skills/self-review/SKILL.md",
    },
  ]);
  const sel = [
    "security-review",
    "run-tests",
    "run-lint",
    "minimalism",
    "review-ticket",
    "self-review",
  ];
  eq(
    detectOpened(sel, text, { roots: ["/x/review-7/"] }),
    ["review-ticket", "self-review"],
    "only the run's own root",
  );
  eq(
    detectOpened(sel, text, { roots: ["/x/review-71"] }),
    ["security-review"],
    "the sibling root claims its own row",
  );
});
check("recordFromOpts unions opened skills into applied and records them", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-telem-ledger-"));
  try {
    const tl = join(dir, "tool-metrics.jsonl");
    writeFileSync(
      tl,
      ledger([
        {
          ts: new Date().toISOString(),
          ticket: "3",
          tool: "Read",
          target: "/wt/.claude/skills/run-lint/SKILL.md",
        },
      ]),
    );
    const rec = recordFromOpts({
      ticket: "3",
      selected: "run-tests, run-lint",
      toolLedger: tl,
      since: new Date(Date.now() - 60000).toISOString(),
    });
    eq(rec.opened, ["run-lint"], "opened");
    eq(rec.applied, ["run-lint"], "applied includes opened");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("recordSkillUsage (the .mjs runners' seam) appends a role record; fail-soft", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-telem-role-"));
  try {
    const rec = recordSkillUsage({
      ticket: "",
      role: "plan",
      stack: "python",
      selected: ["plan-build", "python-conventions"],
      output: "followed the plan-build skill",
      env: { GAFFER_DATA: dir },
    });
    eq(rec.applied, ["plan-build"], "applied from output");
    const rows = readFileSync(join(dir, "skills-telemetry.jsonl"), "utf8").trim().split("\n");
    eq(JSON.parse(rows[0]).role, "plan", "role recorded");
    eq(recordSkillUsage({ role: "plan", env: {} }), null, "no GAFFER_DATA → no write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failures.length) {
  console.error(`skill-telemetry: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`skill-telemetry: ${passed} passed`);
