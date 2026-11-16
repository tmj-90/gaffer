#!/usr/bin/env node
// scripts/config-reference.mjs: docs/CONFIG.md (the fourteen settings),
// docs/CONFIG-ADVANCED.md (every derived value, by the setting that decides it) and
// runner/config/settings-schema.json are derived from the code, not hand-maintained.
// Pin the parser rules that make them honest, the checks that keep the tables and the
// code together, then prove the committed files are current.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const {
  parseConfigDefaults,
  parseTables,
  parseSettingsSpec,
  generateAll,
  model,
  readSiteDefault,
  firstSentence,
  verifyExtraKnobs,
  verifyInternalNames,
  EXTRA_KNOBS,
  INTERNAL_NAMES,
  TEST_SEAMS,
  DEPRECATED,
  REMOVED,
  ENV_ONLY,
} = await import(path.join(ROOT, "scripts", "config-reference.mjs"));

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error(`  FAIL ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok   ${msg}`);
}

console.log("== parser: top-level default wins over mode-branch fills ==");
const fixture = `# header
# --- Section A (ignored suffix) -----
# Two-line comment about FOO. Second sentence.
: "\${FOO:=1}"
: "\${BAR:=x}"   # trailing wins
case "$MODE" in
  autonomous)
    : "\${REVIEW_MODE:=agent}"
    ;;
esac
# ── Section B ─────
: "\${REVIEW_MODE:=human}"
: "\${DERIVED:=$FOO/path}"
: "\${EQ=opus}"
if true; then
  : "\${ONLY_INDENTED:=a}"
else
  : "\${ONLY_INDENTED:=b}"
fi
: "\${RUNNER_DIR:=/x}"
`;
const knobs = parseConfigDefaults(fixture);
const by = Object.fromEntries(knobs.map((k) => [k.name, k]));
ok(
  by.FOO?.default === "1" && by.FOO.section === "Section A",
  "section banner (--- style) groups, parenthetical suffix dropped",
);
ok(by.FOO.doc === "Two-line comment about FOO.", "preceding comment block → first sentence");
ok(by.BAR.doc === "trailing wins", "trailing comment preferred over block");
ok(
  by.REVIEW_MODE.default === "human" && by.REVIEW_MODE.topLevel === true,
  "top-level default beats the earlier indented mode fill",
);
ok(by.REVIEW_MODE.section === "Section B", "── banner style also groups");
ok(
  by.DERIVED.derived === true && by.FOO.derived === false,
  "derived flag set only when the default references another variable",
);
ok(by.EQ?.default === "opus", '`: "${X=default}"` (no colon) is also a default line');
ok(
  by.ONLY_INDENTED?.default === "a" && by.ONLY_INDENTED.topLevel === false,
  "indented-only knob kept (first branch) and flagged",
);
ok(!("RUNNER_DIR" in by), "RUNNER_DIR self-location helper is not a knob");
ok(
  knobs.map((k) => k.name).join(",") === "FOO,BAR,REVIEW_MODE,DERIVED,EQ,ONLY_INDENTED",
  "file order preserved, no duplicates",
);

console.log("== parser: a case statement's default arm (*) is the reported default ==");
const modes = parseConfigDefaults(`case "$GAFFER_MODE" in
  autonomous|strict)
    : "\${AGENT_APPROVE:=1}"
    ;;
  lite)
    : "\${AGENT_APPROVE:=1}"
    ;;
  *)   # supervised (default)
    : "\${AGENT_APPROVE:=0}"
    ;;
esac
case "$X" in
  a)
    : "\${NO_DEFAULT_ARM:=on}"
    ;;
esac
`);
const mb = Object.fromEntries(modes.map((k) => [k.name, k]));
ok(
  mb.AGENT_APPROVE?.default === "0" && mb.AGENT_APPROVE.defaultArm === true,
  "the `*)` arm's fill (supervised: off) wins over the earlier autonomous arm",
);
ok(
  mb.NO_DEFAULT_ARM?.default === "on" && mb.NO_DEFAULT_ARM.defaultArm === false,
  "with no default arm the first branch is kept and flagged",
);

console.log("== read-site defaults ==");
const sh = 'x="${GAFFER_DOD_TIMEOUT:-900}"; y="${GAFFER_NONE}"';
ok(
  readSiteDefault(sh, sh.indexOf("${GAFFER_DOD"), "GAFFER_DOD_TIMEOUT", true) === "900",
  "shell ${X:-900} → 900",
);
ok(
  readSiteDefault(sh, sh.indexOf("${GAFFER_NONE"), "GAFFER_NONE", true) === null,
  "shell ${X} without fallback → null",
);
const ts =
  'const a = process.env.GAFFER_A ?? "abc"; const b = Number(process.env.GAFFER_B || 42); const c = process.env.GAFFER_C ?? compute();';
ok(
  readSiteDefault(ts, ts.indexOf("process.env.GAFFER_A"), "GAFFER_A", false) === "abc",
  'TS `?? "abc"` → abc',
);
ok(
  readSiteDefault(ts, ts.indexOf("process.env.GAFFER_B"), "GAFFER_B", false) === "42",
  "TS `|| 42` → 42",
);
ok(
  readSiteDefault(ts, ts.indexOf("process.env.GAFFER_C"), "GAFFER_C", false) === null,
  "TS computed fallback → null (not a literal)",
);

console.log("== the derivation tables are read as _gaffer_derive reads them ==");
const tfix = `x
_gaffer_derive GAFFER_EFFORT <<'_GAFFER_TABLE_'
#                  small standard large
GAFFER_A           1     2        3      # a note, with # inside
?GAFFER_B          @GAFFER_A            # follows A
GAFFER_C           ~                    # a constant line
_GAFFER_TABLE_
_gaffer_derive GAFFER_MODE --no-export <<'_GAFFER_TABLE_'
REVIEW_MODE human agent agent agent agent   # who reviews
_GAFFER_TABLE_
`;
const tt = parseTables(tfix);
ok(tt.length === 2 && tt[0].setting === "GAFFER_EFFORT" && tt[1].noExport, "two tables, the second --no-export");
ok(
  JSON.stringify(tt[0].rows.map((r) => [r.name, r.unsetOnly, r.cells.join(" "), r.note])) ===
    JSON.stringify([
      ["GAFFER_A", false, "1 2 3", "a note, with # inside"],
      ["GAFFER_B", true, "@GAFFER_A", "follows A"],
      ["GAFFER_C", false, "~", "a constant line"],
    ]),
  "rows: name (?name keeps an explicit empty), cells, and the note after the first #",
);

console.log("== generated files are current ==");
const all = await generateAll();
const text = all.config;
const adv = all.advanced;
for (const [k, rel] of [
  ["config", "docs/CONFIG.md"],
  ["advanced", "docs/CONFIG-ADVANCED.md"],
  ["schema", "runner/config/settings-schema.json"],
]) {
  ok(
    all[k] === readFileSync(path.join(ROOT, rel), "utf8"),
    `${rel} matches the generator output (run: node scripts/config-reference.mjs)`,
  );
}

console.log("== CONFIG.md is the fourteen settings ==");
const settingsText = readFileSync(path.join(ROOT, "runner", "config", "01-settings.sh"), "utf8");
const spec = parseSettingsSpec(settingsText);
ok(spec.length === 14, `the spec holds fourteen settings (${spec.length})`);
const tableRows = text
  .slice(0, text.indexOf("## Credentials"))
  .split("\n")
  .filter((l) => l.startsWith("| `"));
ok(
  tableRows.length === 14 && spec.every((s, i) => tableRows[i].startsWith(`| \`${s.name}\` |`)),
  "its settings table has exactly the fourteen rows, in the spec's order",
);
ok(
  /\| `GAFFER_MODE` \| `supervised` · `lite` · `graduated` · `autonomous` · `strict` \| `supervised` \|/.test(text),
  "GAFFER_MODE shows its accepted values and its default",
);
for (const n of ENV_ONLY)
  ok(new RegExp(`^\\| \`${n}\` \\|`, "m").test(text), `${n} is listed as environment-only`);
ok(
  (text.match(/CONFIG-ADVANCED\.md/g) ?? []).length === 1 &&
    text.trimEnd().endsWith("[Detailed configuration](CONFIG-ADVANCED.md)."),
  "the detailed document is linked once, at the bottom",
);
ok(text.split("\n").length < 80, `short: ${text.split("\n").length} lines`);
const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
ok(!readme.includes("CONFIG-ADVANCED"), "the README never links the detailed document");

console.log("== CONFIG-ADVANCED.md: every derived value, by its setting ==");
const m = model();
for (const s of spec) {
  const at = adv.indexOf(`## \`${s.name}\``);
  ok(at > 0, `${s.name} has a section`);
  const sec = adv.slice(at, adv.indexOf("\n## ", at + 5));
  for (const r of m.tableOf.get(s.name).rows)
    ok(new RegExp(`^\\| \`${r.name}\` \\|`, "m").test(sec), `${r.name} is a row under ${s.name}`);
}
ok(
  /\| Derived value \| small \| standard \(default\) \| large \| Note \|/.test(adv) &&
    /\| `GAFFER_TICK_TIMEOUT` \| `900` \| `1800` \| `3600` \|/.test(adv),
  "a preset table shows what each choice derives (GAFFER_EFFORT: 900 / 1800 / 3600)",
);
ok(adv.includes("export NAME=value"), "it says how to override: export NAME=value");
for (const o of m.oldKeys)
  ok(
    new RegExp(`^\\| \`${o.key}\` \\| \`${o.setting}\` \\|`, "m").test(adv),
    `old key ${o.key} -> ${o.setting} is listed`,
  );
const schema = JSON.parse(all.schema);
ok(
  schema.settings.length === 14 &&
    schema.settings.find((x) => x.name === "GAFFER_EFFORT").derives.find((d) => d.name === "GAFFER_MAX_TURNS")
      .byPreset.large.value === "300",
  "the JSON carries the tables (GAFFER_EFFORT large -> GAFFER_MAX_TURNS 300)",
);

console.log("== the generator refuses tables that drift from the code ==");
async function refusal(file, edit) {
  const f = path.join(ROOT, file);
  const before = readFileSync(f, "utf8");
  try {
    writeFileSync(f, edit(before));
    try {
      await generateAll();
      return "";
    } catch (err) {
      return err.message;
    }
  } finally {
    writeFileSync(f, before);
  }
}
ok(
  /GAFFER_NEW_KNOB has a default but no setting decides it/.test(
    await refusal("runner/config/13-stop.sh", (t) =>
      t.replace(': "${DRY_RUN:=1}"', ': "${DRY_RUN:=1}"\n: "${GAFFER_NEW_KNOB:=1}"   # new'),
    ),
  ),
  "a new default line no setting decides fails the generator",
);
ok(
  /GAFFER_TICK_TIMEOUT has a table value in GAFFER_EFFORT and a default line too/.test(
    await refusal("runner/config/07-limits.sh", (t) =>
      t.replace(": \"${GAFFER_ROLE_MAX_TURNS:=}\"", ': "${GAFFER_TICK_TIMEOUT:=1800}"\n: "${GAFFER_ROLE_MAX_TURNS:=}"'),
    ),
  ),
  "a derived value written twice (table and default line) fails the generator",
);
ok(
  /old key TICK_SLEEP says GAFFER_EFFORT decides it, but it is a row of GAFFER_CONCURRENCY/.test(
    await refusal("runner/config/01-settings.sh", (t) =>
      t.replace("TICK_SLEEP|GAFFER_CONCURRENCY|drop", "TICK_SLEEP|GAFFER_EFFORT|drop"),
    ),
  ),
  "an old key whose setting does not own it fails the generator",
);
ok(
  /GAFFER_CI_POLL_ATTEMPTS: runner\/lib\/ci-gate\.sh falls back to "20" but GAFFER_EFFORT=standard derives "25"/.test(
    await refusal("runner/config/07-limits.sh", (t) =>
      t.replace("GAFFER_CI_POLL_ATTEMPTS         10     20        40", "GAFFER_CI_POLL_ATTEMPTS         10     25        40"),
    ),
  ),
  "a lib fallback that disagrees with the default preset fails the generator",
);

// Exploratory finding fresh-user/CONFIG drift: knobs read only where they are used
// (no default line) were missing, a description was cut mid-word at 220 characters,
// and two rows described the wrong behaviour.
console.log("== descriptions end on a word, not mid-word ==");
ok(typeof firstSentence === "function", "firstSentence is exported for the test");
const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") + ".";
const cut = firstSentence([long]);
ok(cut.length <= 222 && cut.endsWith("…"), "a sentence over the limit is cut and marked with …");
ok(
  /word\d+…$/.test(cut) && long.includes(cut.slice(0, -1) + " "),
  "the cut falls on a word boundary",
);
ok(
  firstSentence(["Short one (see a.b: c). Second."]) === "Short one (see a.b: c).",
  "a short first sentence is kept whole",
);
const rows = text.split("\n").filter((l) => l.startsWith("| `"));
const cutMid = rows.filter((l) => {
  const notes = l.split(" | ").at(-1).replace(/ \|$/, "").trim();
  return notes.length >= 200 && !/[.!?)`"':…]$/.test(notes);
});
ok(
  cutMid.length === 0,
  `no long description stops mid-word (${cutMid.map((l) => l.split(" | ")[0]).join(", ")})`,
);

console.log("== knobs read where they are used are documented ==");
for (const name of [
  "GAFFER_STRICT_REQUIRE",
  "GAFFER_DOD",
  "GAFFER_DOD_INSTALL",
  "GAFFER_ALLOW_NO_DOD",
  "GAFFER_CI_TIMEOUT_POLICY",
  "GAFFER_MEMORY_AUTO_PROMOTE",
  "GAFFER_SANDBOX_IMAGE",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
]) {
  ok(new RegExp(`^\\| \`${name}\` \\|`, "m").test(text + adv), `${name} has a row`);
}
ok(/\| `GAFFER_DOD_INSTALL` \| `1` _\(read in/.test(adv), "GAFFER_DOD_INSTALL shows its real default (1)");
ok(/\| `GAFFER_CI_TIMEOUT_POLICY` \| `block` _\(read in/.test(adv), "GAFFER_CI_TIMEOUT_POLICY defaults to block");

console.log("== the read-site table fails when it drifts from the code ==");
ok(verifyExtraKnobs(ROOT) === undefined, "every EXTRA_KNOBS entry matches its read site today");
const drift = gafferMkdtemp(path.join(os.tmpdir(), "config-ref-drift-"));
try {
  mkdirSync(path.join(drift, "lib"), { recursive: true });
  writeFileSync(path.join(drift, "lib", "a.sh"), 'x="${KNOB_A:-block}"\n');
  writeFileSync(path.join(drift, "lib", "b.mjs"), 'const v = process.env.KNOB_B ?? "1";\n');
  const extras = [
    { name: "KNOB_A", default: "block", file: "lib/a.sh" },
    { name: "KNOB_B", default: "1", file: "lib/b.mjs" },
  ];
  const throws = (list) => {
    try {
      verifyExtraKnobs(drift, list);
      return "";
    } catch (err) {
      return err.message;
    }
  };
  ok(throws(extras) === "", "a table that matches its fixture passes");
  ok(
    /KNOB_A: documented default "proceed" but lib\/a\.sh falls back to "block"/.test(
      throws([{ ...extras[0], default: "proceed" }]),
    ),
    "a shell default that changed is reported",
  );
  ok(
    /KNOB_B: documented default "0" but lib\/b\.mjs falls back to "1"/.test(
      throws([{ ...extras[1], default: "0" }]),
    ),
    "a JS default that changed is reported",
  );
  ok(
    /KNOB_C: no longer read in lib\/a\.sh/.test(
      throws([{ name: "KNOB_C", default: "", file: "lib/a.sh" }]),
    ),
    "a knob its file no longer reads is reported",
  );
  ok(
    /lib\/gone\.sh does not exist/.test(
      throws([{ name: "KNOB_A", default: "block", file: "lib/gone.sh" }]),
    ),
    "a read site that moved is reported",
  );
} finally {
  rmSync(drift, { recursive: true, force: true });
}
ok(
  EXTRA_KNOBS.every((k) => new RegExp(`^\\| \`${k.name}\` \\|`, "m").test(text + adv)),
  "every EXTRA_KNOBS entry has a row in docs/CONFIG.md or docs/CONFIG-ADVANCED.md",
);

console.log("== internal names and test seams are named once, never as rows ==");
ok(
  verifyInternalNames(ROOT) === undefined,
  "every INTERNAL_NAMES / TEST_SEAMS entry still occurs in the source",
);
const internalSection = adv.slice(adv.indexOf("## Internal names (not knobs)"), adv.indexOf("## Who reads what"));
ok(
  internalSection.length > 0 && adv.includes("## Internal names (not knobs)"),
  "CONFIG-ADVANCED.md has the Internal names section",
);
for (const name of [...INTERNAL_NAMES.flatMap((g) => g.names), ...TEST_SEAMS]) {
  ok(
    !new RegExp(`^\\| \`${name}\` \\|`, "m").test(text + adv.slice(0, adv.indexOf("## Internal names"))) &&
      internalSection.includes(`\`${name}\``),
    `${name} is in the Internal names section and has no table row`,
  );
}
for (const name of [
  "GAFFER_KEEP_DELIVERY_BRANCH",
  "GAFFER_SANDBOX_PROFILE",
  "GAFFER_PAUSE_KEEP_WORKTREE",
])
  ok(internalSection.includes(`\`${name}\``), `${name} (set by the runner) is listed as plumbing`);
// A `: "${X:=v}"` line is how the config marks a knob, so an internal name with one is an error.
{
  const cfg = path.join(ROOT, "runner", "config", "02-paths.sh");
  const before = readFileSync(cfg, "utf8");
  try {
    writeFileSync(
      cfg,
      before.replace(/^DISPATCH_DIR="\$\{DISPATCH_DIR:-(.*)\}"$/m, ': "${DISPATCH_DIR:=$1}"'),
    );
    let msg = "";
    try {
      await generateAll();
    } catch (err) {
      msg = err.message;
    }
    ok(
      /listed as internal but still defaulted[^\n]*DISPATCH_DIR/.test(msg),
      "an internal name defaulted like a knob fails the generator",
    );
  } finally {
    writeFileSync(cfg, before);
  }
}

console.log("== deprecated and removed names have their own tables ==");
{
  const dep = adv.slice(adv.indexOf("## Deprecated"), adv.indexOf("## Internal names"));
  for (const d of DEPRECATED)
    ok(
      new RegExp(`^\\| \`${d.name}\` \\|`, "m").test(dep) &&
        !new RegExp(`^\\| \`${d.name}\` \\|`, "m").test(text + adv.slice(0, adv.indexOf("## Deprecated"))),
      `${d.name} is in the Deprecated table only`,
    );
  const rem = adv.slice(adv.indexOf("### Removed"), adv.indexOf("## Internal names"));
  for (const d of REMOVED)
    ok(new RegExp(`^\\| \`${d.name}\` \\|`, "m").test(rem), `${d.name} is in the Removed table`);
}

console.log("== rows describe the behaviour ==");
const srow = (k) => text.split("\n").find((l) => l.startsWith(`| \`${k}\` |`)) ?? "";
ok(
  !/on top of autonomous/i.test(srow("GAFFER_MODE")),
  "GAFFER_MODE does not say strict adds a sandbox on top",
);
ok(
  /strict \(autonomous, and the sandbox wraps the agent even under the environment opt-out\)/.test(srow("GAFFER_MODE")),
  "GAFFER_MODE says strict is autonomous plus the sandbox under the opt-out",
);

console.log(`\nconfig-reference: ALL ${passed} checks passed`);
