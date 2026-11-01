#!/usr/bin/env node
// scripts/config-reference.mjs — the generated docs/CONFIG.md must be derived
// from the code, not hand-maintained. Pin the parser rules that make the
// reference honest, then prove the committed file is current.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const { parseConfigDefaults, generate, readSiteDefault, firstSentence } = await import(
  path.join(ROOT, "scripts", "config-reference.mjs")
);

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

console.log("== generated reference is current ==");
const text = await generate();
const committed = readFileSync(path.join(ROOT, "docs", "CONFIG.md"), "utf8");
ok(
  text === committed,
  "docs/CONFIG.md matches the generator output (run: node scripts/config-reference.mjs)",
);
ok(
  /\| `GAFFER_MODE` \| `supervised` \| yes \(string: supervised/.test(text),
  "GAFFER_MODE row shows the real default + UI choices",
);
ok(
  /\| `REVIEW_MODE` \| `human` \|/.test(text),
  "REVIEW_MODE shows the top-level default, not the autonomous-mode fill",
);
ok(
  /\| `SANDBOX_PROVIDER` \| string: sandbox-exec/.test(text),
  "dashboard-only section lists SANDBOX_PROVIDER",
);
ok(
  /\| `GAFFER_DOD_TIMEOUT` \| `900` \|/.test(text) &&
    !/\| `GAFFER_DOD_TIMEOUT` \| `900` \| `runner/.test(text),
  "GAFFER_DOD_TIMEOUT is a documented runner default now (not an undocumented read)",
);
ok(
  /### lib\/skills-mount\.sh[\s\S]*\| `GAFFER_UNIVERSAL_SKILLS` \|/.test(text),
  "a knob defaulted in runner/lib/*.sh is listed under its lib section",
);
ok(
  !/\| `GAFFER_DOD_INSTALL_TIMEOUT` \| [^|]*\| `runner\/lib\/dod\.sh`/.test(text),
  "a lib-defaulted knob is not reported as an undocumented read",
);
ok(
  /\| `GAFFER_ONBOARD_TIMEOUT` \| [^|]*\| `runner\/lib\/onboard-analyze\.mjs`/.test(text),
  "a read with no default anywhere is still listed as undocumented",
);
ok(
  !/\| `GAFFER_STRICT_REQUIRE` \| `runner/.test(text),
  "a variable the config assigns itself is not reported as undocumented",
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
  "GAFFER_GREENFIELD_INSTALL",
  "GAFFER_ALLOW_NO_DOD",
  "GAFFER_KEEP_DELIVERY_BRANCH",
  "GAFFER_CI_TIMEOUT_POLICY",
  "GAFFER_MEMORY_AUTO_PROMOTE",
  "GAFFER_SANDBOX_IMAGE",
  "GAFFER_SANDBOX_PROFILE",
  "GAFFER_DIGEST_DISABLE",
  "GAFFER_PAUSE_KEEP_WORKTREE",
  "GAFFER_VERBOSE",
  "DEMO_DIR",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
]) {
  ok(new RegExp(`^\\| \`${name}\` \\|`, "m").test(text), `${name} has a row`);
}
ok(/\| `GAFFER_DOD_INSTALL` \| `1` \|/.test(text), "GAFFER_DOD_INSTALL shows its real default (1)");
ok(
  /\| `GAFFER_CI_TIMEOUT_POLICY` \| `block` \|/.test(text),
  "GAFFER_CI_TIMEOUT_POLICY defaults to block",
);
ok(/\| `DEMO_DIR` \| `\/tmp\/gaffer-showcase` \|/.test(text), "DEMO_DIR shows the demo's path");

console.log("== rows describe the behaviour ==");
const row = (k) => rows.find((l) => l.startsWith(`| \`${k}\` |`)) ?? "";
ok(
  !/on top of autonomous/i.test(row("GAFFER_MODE")),
  "GAFFER_MODE does not say strict adds a sandbox on top",
);
ok(
  /same flags/i.test(row("GAFFER_MODE")),
  "GAFFER_MODE says strict and autonomous set the same flags",
);
const attempts = row("GAFFER_MAX_DELIVERY_ATTEMPTS");
ok(
  /gate/i.test(attempts) && /GAFFER_MAX_NOCOMMIT_FAILURES/.test(attempts),
  "MAX_DELIVERY_ATTEMPTS: gate rework + the no-commit cap",
);
ok(/identical/i.test(attempts), "MAX_DELIVERY_ATTEMPTS: the two-identical-failures early stop");

console.log(`\nconfig-reference: ALL ${passed} checks passed`);
