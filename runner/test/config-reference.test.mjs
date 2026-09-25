#!/usr/bin/env node
// scripts/config-reference.mjs — the generated docs/CONFIG.md must be derived
// from the code, not hand-maintained. Pin the parser rules that make the
// reference honest, then prove the committed file is current.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const { parseConfigDefaults, generate } = await import(
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
  /\| `GAFFER_DOD_TIMEOUT` \| /.test(text),
  "undocumented-read section surfaces GAFFER_DOD_TIMEOUT",
);
ok(
  !/\| `GAFFER_STRICT_REQUIRE` \| `runner/.test(text),
  "a variable the config assigns itself is not reported as undocumented",
);

console.log(`\nconfig-reference: ALL ${passed} checks passed`);
