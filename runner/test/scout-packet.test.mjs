#!/usr/bin/env node
// =====================================================================
// The pre-work scout's deterministic packet and the risk classifier (delta roadmap
// gap 3): stack-trace seeds, index expansion with reasons, the 25-file bound, the
// no-index degrade, the model scout's validation, and one case per risk signal
// (each can only raise the declared level). Run: node test/scout-packet.test.mjs
// =====================================================================
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, "..", "lib");
const S = await import(resolve(LIB, "scout.mjs"));
const R = await import(resolve(LIB, "risk-classify.mjs"));

let passed = 0;
let failed = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ` :: ${extra}` : ""}`);
  }
};

const files = new Set([
  "src/billing/invoice.ts",
  "src/billing/index.ts",
  "src/api/orders.ts",
  "src/api/cart.ts",
  "test/invoice.test.ts",
  "app/views/checkout.py",
  "db/migrations/0042_add_total.sql",
  "src/main/java/com/acme/billing/Invoice.java",
  "config/app.config.ts",
  "packages/web/src/page.ts",
]);
const show = (description, extra = {}) => ({
  ticket: {
    title: "Fix invoice totals",
    description,
    risk_level: "low",
    attempt_count: 0,
    ...extra.ticket,
  },
  repositories: extra.repositories ?? [
    { id: "r1", name: "shop", access: "write", relation: "confirmed", test_command: "pnpm test" },
  ],
  reworkTrail: extra.reworkTrail ?? [],
});
const fresh = (items, commit = "abc1234") => ({
  status: "fresh",
  build: { commit, capsHit: [] },
  items,
});
const nbItem = (o) => ({
  query: o.path,
  path: o.path,
  symbol: o.symbol ?? null,
  note: null,
  callers: o.callers ?? [],
  callersTotal: o.callersTotal ?? (o.callers ?? []).length,
  tests: o.tests ?? [],
  testsTotal: (o.tests ?? []).length,
  moduleTestsTotal: o.moduleTestsTotal ?? (o.tests ?? []).length,
});

console.log("== A. stack-trace seeds ==");
{
  const text = `TypeError: x is undefined
    at calc (/home/ci/work/shop/src/billing/invoice.ts:42:13)
    at Object.<anonymous> (node_modules/jest/build/index.js:9:1)
  File "/srv/app/app/views/checkout.py", line 88, in post
  at com.acme.billing.Invoice.total(Invoice.java:17)
  at node:internal/process/task_queues:95:5`;
  const seeds = S.stackTraceSeeds(text);
  ok(
    seeds.length === 3,
    "three frames kept (node_modules and node: internals dropped)",
    JSON.stringify(seeds),
  );
  const resolved = seeds.map((f) => S.resolveSeedPath(f.candidates, files));
  ok(
    resolved.includes("src/billing/invoice.ts"),
    "an absolute JS frame resolves by its unique suffix",
  );
  ok(resolved.includes("app/views/checkout.py"), 'a Python File "...", line N frame resolves');
  ok(
    resolved.includes("src/main/java/com/acme/billing/Invoice.java"),
    "a Java frame resolves through its package path",
  );
  ok(
    S.resolveSeedPath(["/x/y/nowhere.ts"], files) === null,
    "an unknown frame resolves to nothing",
  );
  ok(
    S.resolveSeedPath(["index.ts"], new Set(["a/index.ts", "b/index.ts"])) === null,
    "an ambiguous suffix resolves to nothing",
  );
  const many = Array.from({ length: 30 }, (_, i) => `at f (src/f${i}.ts:${i + 1}:1)`).join("\n");
  ok(S.stackTraceSeeds(many).length === S.MAX_SEEDS, `at most ${S.MAX_SEEDS} frames`);
}

console.log("== A2. frames from other machines, ties said, a large tree ==");
{
  ok(
    S.resolveSeedPath(
      S.stackTraceSeeds(
        "Error\n    at calc (C:\\Users\\me\\shop\\src\\billing\\invoice.ts:42:13)",
      )[0]?.candidates ?? [],
      files,
    ) === "src/billing/invoice.ts",
    "a Windows JS frame (backslashes) resolves by its suffix",
  );
  ok(
    S.resolveSeedPath(
      S.stackTraceSeeds("at calc (file:///C:/ci/shop/src/api/cart.ts:3:9)")[0]?.candidates ?? [],
      files,
    ) === "src/api/cart.ts",
    "a file:///C:/ frame resolves",
  );
  const tie = new Set(["a/util/index.js", "b/util/index.js", "src/app.ts"]);
  const p = S.buildPacket({
    show: show("at f (/ci/x/util/index.js:3:1)\nat g (/elsewhere/deep/app.ts:9:1)"),
    named: "",
    files: tie,
    nb1: null,
  });
  ok(
    p.unresolved_frames.length === 1 && /\(matches 2 files\)$/.test(p.unresolved_frames[0]),
    "a frame two files match is not placed, and the packet says it is a tie",
    JSON.stringify(p.unresolved_frames),
  );
  ok(
    p.items.length === 1 &&
      p.items[0].reasons[0] === "stack trace (line 9, matched by file name only)",
    "a frame whose directories the tree lacks says it matched by file name only",
    JSON.stringify(p.items),
  );
  const sum = S.promptSummary(p, null);
  ok(
    sum && sum.unplacedFrames && /matches 2 files/.test(sum.unplacedFrames[0]),
    "the prompt input carries the unplaced frame",
    JSON.stringify(sum),
  );
  const only = S.buildPacket({
    show: show("at f (/ci/x/util/index.js:3:1)"),
    named: "",
    files: tie,
    nb1: null,
  });
  ok(
    S.promptSummary(only, null)?.items.length === 0,
    "a ticket whose only frame is a tie still gets a summary that says so",
  );
  ok(
    !(
      "unplacedFrames" in
      (S.promptSummary(
        S.buildPacket({ show: show("x"), named: "P\tsrc/api/cart.ts\n", files, nb1: null }),
        null,
      ) || {})
    ),
    "no unplaced frame: no key (the prompt input is unchanged)",
  );
  const big = new Set();
  for (let i = 0; i < 200000; i++) big.add(`pkg${i % 500}/src/d${i % 37}/f${i}.ts`);
  big.add("src/billing/invoice.ts");
  const frames = Array.from({ length: 10 }, (_, i) => `at f (/a/b/c/d/e/f/g/h/nope${i}.ts:1:1)`);
  frames.push("at f (/home/ci/shop/src/billing/invoice.ts:4:2)");
  const t0 = Date.now();
  const sd = S.seeds({ show: show(frames.join("\n")), named: "", files: big });
  const took = Date.now() - t0;
  ok(
    sd.paths.length === 0 || sd.paths[0] === "src/billing/invoice.ts",
    "a large tree: frames resolve",
  );
  ok(took < 5000, `a 200k-file tree with 10 frames resolves in bounded time (${took} ms)`);
}

console.log("== B. the packet: named, index expansion, reasons ==");
{
  const named = "P\tsrc/billing/invoice.ts\nS\tcalculateInvoice\n";
  const nb1 = fresh([
    nbItem({
      path: "src/billing/invoice.ts",
      callers: [{ path: "src/api/orders.ts", via: "name", through: null, line: 3 }],
      tests: [{ path: "test/invoice.test.ts", via: "import", through: null }],
    }),
    {
      ...nbItem({
        path: "src/billing/invoice.ts",
        symbol: "calculateInvoice",
        callers: [
          { path: "src/api/cart.ts", via: "barrel", through: "src/billing/index.ts", line: 1 },
        ],
      }),
      query: "calculateInvoice",
    },
  ]);
  const nb2 = fresh([
    nbItem({
      path: "src/api/orders.ts",
      callers: [{ path: "config/app.config.ts", via: "name", through: null, line: 2 }],
    }),
  ]);
  const p = S.buildPacket({
    show: show("See `calculateInvoice()` in src/billing/invoice.ts"),
    named,
    files,
    nb1,
    nb2,
    baseSha: "abc1234",
    attempt: 1,
  });
  const by = Object.fromEntries(p.items.map((i) => [i.path, i]));
  ok(by["src/billing/invoice.ts"]?.reasons[0] === "named", "the named path is first, reason named");
  ok(
    by["src/billing/invoice.ts"]?.reasons.includes("defines calculateInvoice (named)"),
    "the named symbol's module says it defines it",
  );
  ok(
    by["test/invoice.test.ts"]?.reasons.includes("tests src/billing/invoice.ts"),
    "a test says what it tests",
  );
  ok(
    by["src/api/orders.ts"]?.reasons.includes("imports src/billing/invoice.ts"),
    "a caller says what it imports",
  );
  ok(
    by["src/api/cart.ts"]?.reasons.includes(
      "imports calculateInvoice through src/billing/index.ts",
    ),
    "a barrel caller names the barrel",
  );
  ok(
    by["config/app.config.ts"]?.reasons.includes("imports src/api/orders.ts (2 hops)") &&
      by["config/app.config.ts"].reasons.includes("config"),
    "a second-hop importer is labelled 2 hops, and its config tag is a reason",
  );
  ok(p.index.status === "fresh" && p.index.used && p.index.hop2, "the index status is recorded");
  ok(
    p.counts.named === 1 && p.counts.index === 4,
    "counts split named vs index",
    JSON.stringify(p.counts),
  );
  ok(p.test_commands[0]?.command === "pnpm test", "the write repo's test command is in the packet");
  ok(
    JSON.stringify(S.hop2Paths(nb1)) === JSON.stringify(["src/api/orders.ts", "src/api/cart.ts"]),
    "hop2 asks about the first-hop callers",
  );
}

console.log("== C. bounded ==");
{
  const callers = Array.from({ length: 60 }, (_, i) => ({
    path: `src/c${i}.ts`,
    via: "name",
    through: null,
    line: 1,
  }));
  const p = S.buildPacket({
    show: show("x"),
    named: "P\tsrc/billing/invoice.ts\n",
    files: null,
    nb1: fresh([nbItem({ path: "src/billing/invoice.ts", callers, callersTotal: 60 })]),
  });
  ok(p.items.length === S.MAX_ITEMS, `at most ${S.MAX_ITEMS} files`, String(p.items.length));
  ok(p.omitted === 61 - S.MAX_ITEMS, "the rest is counted as omitted", String(p.omitted));
  ok(
    p.items.every((i) => i.reasons.length <= S.MAX_REASONS),
    "at most 3 reasons per file",
  );
  const evil = S.buildPacket({
    show: show("x"),
    named: "P\t../../etc/passwd\nP\tsrc/$(rm -rf).ts\nS\t<untrusted-x>\n",
    files: null,
    nb1: null,
  });
  ok(evil.items.length === 0, "unsafe names never enter the packet");
}

console.log("== D. fail-soft: no index, stale index ==");
{
  const text = "Crash:\n    at calc (src/billing/invoice.ts:42:13)";
  for (const nb1 of [null, { status: "missing", items: [] }, fresh([], "old")]) {
    const stale = nb1 && nb1.build ? { ...nb1, status: "stale" } : nb1;
    const p = S.buildPacket({
      show: show(text),
      named: "P\tsrc/api/orders.ts\n",
      files,
      nb1: stale,
    });
    ok(
      p.items.length === 2 && !p.index.used && p.counts.index === 0,
      `index ${stale ? stale.status : "unavailable"}: named and stack items only`,
      JSON.stringify(p.items),
    );
    ok(
      p.items.find((i) => i.path === "src/billing/invoice.ts")?.reasons[0] ===
        "stack trace (line 42)",
      "the stack frame is a seed",
    );
  }
  const p = S.buildPacket({ show: show("x"), named: "P\tsrc/gone.ts\n", files, nb1: null });
  ok(
    p.items.length === 0 && p.missing_named[0] === "src/gone.ts",
    "a named path not in the base tree is listed as missing, not as an item",
  );
  ok(
    S.buildPacket({ show: {}, named: "", files: null, nb1: null }).items.length === 0,
    "an empty ticket gives an empty packet",
  );
  ok(
    S.promptSummary(S.buildPacket({ show: {}, named: "", files: null, nb1: null }), null) === null,
    "an empty packet gives no prompt input",
  );
}

console.log("== E. model scout reply: validated against the checkout ==");
{
  const base = S.buildPacket({
    show: show("x"),
    named: "P\tsrc/api/orders.ts\n",
    files,
    nb1: null,
  });
  const reply = S.parseModelReply(
    'Here you go\n```json\n{"files":[{"path":"src/billing/invoice.ts","why":"computes totals"},{"path":"src/ghost.ts","why":"x"},"../etc/passwd"],' +
      '"symbols":[{"name":"calculateInvoice","path":"src/billing/invoice.ts"},{"name":"nope","path":"src/billing/invoice.ts"}],' +
      `"notes":[${Array.from({ length: 14 }, (_, i) => `"note ${i}"`).join(",")}]}\n\`\`\``,
  );
  ok(reply && Array.isArray(reply.files), "the fenced JSON reply parses");
  const m = S.mergeModel(base, reply, {
    files,
    fileHas: (p, n) => p === "src/billing/invoice.ts" && n === "calculateInvoice",
    usage: { cost_usd: 0.012, model: "cheap" },
  });
  ok(
    m.model_scout.kept_files === 1 && m.model_scout.dropped_files === 2,
    "paths that do not exist are dropped",
    JSON.stringify(m.model_scout),
  );
  ok(
    m.model_scout.kept_symbols === 1 && m.model_scout.dropped_symbols === 1,
    "symbols must be in the file",
  );
  ok(m.model_scout.notes.length === S.MAX_NOTES, "at most 10 notes");
  ok(m.items.length === base.items.length, "the deterministic items are unchanged");
  ok(m.model_scout.cost_usd === 0.012, "the scout's cost is kept");
  const s = S.promptSummary(m, null);
  ok(
    s.model && s.model.files[0].path === "src/billing/invoice.ts" && s.model.dropped === 3,
    "the summary carries what the model suggested and how much was dropped",
  );
  ok(S.parseModelReply("no json here") === null, "a reply with no JSON parses to null");
  const none = S.mergeModel(base, null, { files, fileHas: () => false, usage: {} });
  ok(
    none.model_scout.ran && !none.model_scout.parsed,
    "an unparseable reply is recorded as ran, not parsed",
  );
}

console.log("== F. risk classifier: each signal, only raises ==");
{
  const pk = (o = {}) => ({
    items: o.items ?? [],
    seed_facts: o.facts ?? [],
    index: { used: o.used ?? true, caps_hit: [] },
    prior: o.prior ?? { sent_back: 0, gates: [] },
  });
  const item = (path, sources = ["named"], reasons = ["named"]) => ({
    path,
    sources,
    reasons,
    tags: S.pathTags(path),
  });
  const cases = [
    [
      "migration file",
      show("x"),
      pk({ items: [item("db/migrations/0042_add_total.sql", ["index"], ["imports x"])] }),
      "migration",
      "high",
    ],
    [
      "migration in the text",
      show("Write the migration for the totals column"),
      pk(),
      "migration",
      "high",
    ],
    ["auth path", show("x"), pk({ items: [item("src/auth/session.ts")] }), "auth", "high"],
    ["auth words", show("Only admins have permission to refund"), pk(), "auth", "high"],
    [
      "schema file",
      show("x"),
      pk({ items: [item("api/orders.proto", ["index"], ["tests x"])] }),
      "schema",
      "medium",
    ],
    [
      "public API entry",
      show("x"),
      pk({ items: [item("src/billing/index.ts")] }),
      "public_api",
      "medium",
    ],
    [
      "cross-package callers",
      show("x"),
      pk({
        facts: [
          {
            path: "packages/core/src/a.ts",
            symbol: "a",
            callers_total: 2,
            tests_total: 1,
            module_tests_total: 1,
            cross_package_callers: 2,
          },
        ],
      }),
      "public_api",
      "medium",
    ],
    [
      "concurrency words",
      show("Fix the race condition on double submit"),
      pk(),
      "concurrency",
      "medium",
    ],
    [
      "cross-repo",
      show("x", {
        repositories: [
          { name: "a", access: "write", relation: "confirmed" },
          { name: "b", access: "write", relation: "confirmed" },
        ],
      }),
      pk(),
      "cross_repo",
      "medium",
    ],
    [
      "prior send-back",
      show("x", { ticket: { attempt_count: 1 } }),
      pk({ prior: { sent_back: 1, gates: [] } }),
      "prior_failure",
      "medium",
    ],
    [
      "prior gate retry",
      show("x"),
      pk({ prior: { sent_back: 0, gates: ["tests"] } }),
      "prior_failure",
      "medium",
    ],
    [
      "fan-out",
      show("x"),
      pk({
        facts: [
          {
            path: "src/a.ts",
            symbol: "a",
            callers_total: 14,
            tests_total: 2,
            module_tests_total: 2,
            cross_package_callers: 0,
          },
        ],
      }),
      "fan_out",
      "medium",
    ],
    [
      "fan-out high",
      show("x"),
      pk({
        facts: [
          {
            path: "src/a.ts",
            symbol: "a",
            callers_total: 30,
            tests_total: 2,
            module_tests_total: 2,
            cross_package_callers: 0,
          },
        ],
      }),
      "fan_out",
      "high",
    ],
    [
      "untested module",
      show("x"),
      pk({
        facts: [
          {
            path: "src/a.ts",
            symbol: null,
            callers_total: 1,
            tests_total: 0,
            module_tests_total: 0,
            cross_package_callers: 0,
          },
        ],
      }),
      "untested",
      "medium",
    ],
  ];
  for (const [name, sh, packet, kind, level] of cases) {
    const r = R.classify({ show: sh, packet });
    const s = r.signals.find((x) => x.kind === kind);
    ok(
      s && s.level === level && r.effective === level && r.raised,
      `${name}: ${kind} raises low to ${level}`,
      JSON.stringify(r),
    );
  }
  const quiet = R.classify({ show: show("Rename a label"), packet: pk() });
  ok(
    !quiet.raised && quiet.effective === "low" && quiet.signals.length === 0,
    "no signal: the declared level stands",
  );
  const high = R.classify({
    show: show("x", { ticket: { risk_level: "high" } }),
    packet: pk({ items: [item("src/billing/index.ts")] }),
  });
  ok(
    high.effective === "high" && !high.raised && !high.signals[0].raises,
    "a signal below the declared level never lowers it",
  );
  const crit = R.classify({
    show: show("migration", { ticket: { risk_level: "critical" } }),
    packet: pk(),
  });
  ok(crit.effective === "critical", "declared critical stays critical");
  const noCrit = R.classify({ show: show("auth migration"), packet: pk() });
  ok(noCrit.effective === "high", "signals never ask for critical");
  ok(
    R.classify({
      show: show("x"),
      packet: pk({
        used: false,
        facts: [
          {
            path: "src/a.ts",
            callers_total: 0,
            tests_total: 0,
            module_tests_total: 0,
            cross_package_callers: 0,
          },
        ],
      }),
    }).signals.length === 0,
    "no untested claim without the index",
  );
  const two = R.classify({
    show: show("x", { ticket: { risk_level: "medium" } }),
    packet: pk({
      items: [item("db/migrations/0042_add_total.sql")],
      facts: [
        {
          path: "src/a.ts",
          symbol: "a",
          callers_total: 14,
          tests_total: 1,
          module_tests_total: 1,
          cross_package_callers: 0,
        },
      ],
    }),
  });
  ok(
    R.raisedSentence(two) ===
      "risk raised to high (declared medium): migration file db/migrations/0042_add_total.sql",
    "the sentence names only the signals that raised it",
    R.raisedSentence(two),
  );
  ok(
    R.classify({ show: {}, packet: null }).effective === "medium",
    "a ticket without a level reads as medium (tick.sh's default)",
  );
}

console.log("== G. selection telemetry line ==");
{
  const p = S.buildPacket({
    show: show("x"),
    named: "P\tsrc/api/orders.ts\n",
    files,
    nb1: null,
    attempt: 2,
  });
  const line = S.selectionLine({
    packet: p,
    risk: { declared: "low", effective: "medium", raised: true },
    ticket: "7",
    attempt: 2,
    skills: "fix-bug, typescript",
    lenses: "minimalism",
    model: "mid",
    routeReasons: ["phase implement"],
    cardPaths: ["src/a.ts"],
    now: new Date("2026-11-03T00:00:00Z"),
  });
  ok(
    line.files[0].path === "src/api/orders.ts" && line.files[0].reasons[0] === "named",
    "files carry their reasons",
  );
  ok(
    line.skills.length === 3 && line.skills[2].reason === "always-on quality lens",
    "skills and lenses carry a reason",
  );
  ok(
    line.scout.index_status === "unavailable" && line.scout.from_index === 0,
    "the scout's coverage is on the line",
  );
  ok(line.risk.raised && line.cards[0].reason === "file card", "risk and cards are on the line");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
