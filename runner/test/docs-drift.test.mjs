#!/usr/bin/env node
// =====================================================================
// Docs that state a COUNT or a DEFAULT must match the code they describe. These
// drifted (the gap analysis found 118 / ~70 skills, "7 views" with 11 in the nav, a
// shipped spec plan still "in progress", and CONFIG.md listing the agent-approve and
// memory-auto-approve flags as on by default). Each is pinned here against its source:
//   D1 every skill count in README / ARCHITECTURE / runner/README = the runner/skills dirs
//   D2 the dashboard view count in ARCHITECTURE = the NAV entries in the SPA (web/js/chrome.js)
//   D3 docs/FEATURES.md's Specs section does not say "in progress" (it shipped)
//   D4 CONFIG.md and the settings help say DISPATCH_ALLOW_AGENT_APPROVE and
//      MEMORY_AUTO_APPROVE are off by default (the supervised mode's fill)
//   D5 every image README / quickstart / docs/*.md shows exists, has alt text that
//      says what is on it, and every file in docs/img is shown somewhere (the
//      screenshot script, scripts/screenshots.mjs, writes them by name)
// Run: node runner/test/docs-drift.test.mjs
// =====================================================================
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => readFileSync(resolve(ROOT, f), "utf8");
let pass = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("== D1: skill counts ==");
const skillsDir = resolve(ROOT, "runner/skills");
const skills = readdirSync(skillsDir).filter((d) =>
  statSync(resolve(skillsDir, d)).isDirectory(),
).length;
check(`the library has skills (${skills})`, skills > 0);
for (const f of ["README.md", "ARCHITECTURE.md", "runner/README.md"]) {
  const text = read(f);
  const stated = [...text.matchAll(/(?:~\s*)?\*{0,2}(\d+)\*{0,2}[- ]skills?\b/gi)].map((m) => m[0]);
  check(`${f} states the skill count`, stated.length > 0, "no count found");
  for (const s of stated) {
    const n = Number(s.match(/\d+/)[0]);
    check(`${f}: "${s}" is ${skills}`, n === skills && !s.startsWith("~"), `stated ${s}`);
  }
}

console.log("== D2: dashboard view count ==");
const app = read("packages/dispatch/src/api/web/js/chrome.js");
const navBlock = app.slice(
  app.indexOf("const NAV = ["),
  app.indexOf("];", app.indexOf("const NAV = [")),
);
const views = (navBlock.match(/\{\s*id:\s*"/g) || []).length;
check(`the nav has views (${views})`, views > 0);
const arch = read("ARCHITECTURE.md");
const vm = arch.match(/web dashboard \((\d+) views\)/);
check("ARCHITECTURE.md states the view count", !!vm);
check(
  `ARCHITECTURE.md: ${vm?.[1]} views is ${views}`,
  vm && Number(vm[1]) === views,
  `stated ${vm?.[1]}`,
);

console.log("== D3: the Specs feature is described as shipped, not 'in progress' ==");
const featuresDoc = read("docs/FEATURES.md");
const specStart = featuresDoc.indexOf("## Specs");
const specEnd = featuresDoc.indexOf("\n## ", specStart + 1);
const spec =
  specStart === -1 ? "" : featuresDoc.slice(specStart, specEnd === -1 ? undefined : specEnd);
check("FEATURES.md has a Specs section", spec.length > 0);
check("no 'in progress' in the Specs section", !/in progress/i.test(spec));

console.log("== D4: the two autonomy flags are off by default in the docs ==");
// Neither is a setting any more: GAFFER_MODE decides both, and the default mode
// (supervised) derives 0. The generated detailed document, the schema the dashboard
// reads and the config's own table must all say so.
const schema = JSON.parse(read("runner/config/settings-schema.json"));
const mode = schema.settings.find((x) => x.name === "GAFFER_MODE") || { derives: [] };
check("the default mode is supervised", mode.default === "supervised", String(mode.default));
const advanced = read("docs/CONFIG-ADVANCED.md");
const modeTable = read("runner/config/15-modes.sh");
for (const k of ["DISPATCH_ALLOW_AGENT_APPROVE", "MEMORY_AUTO_APPROVE"]) {
  const row = advanced.split("\n").find((l) => l.startsWith(`| \`${k}\` |`)) || "";
  const dflt = row.split("|")[2] || "";
  check(
    `CONFIG-ADVANCED.md: ${k} is 0 under the default mode`,
    /^\s*`0`\s*$/.test(dflt),
    dflt.trim(),
  );
  const d = mode.derives.find((x) => x.name === k);
  const cell = d && d.byPreset ? d.byPreset.supervised : null;
  check(
    `the settings schema derives ${k}=0 under supervised`,
    !!cell && cell.how === "value" && cell.value === "0",
    JSON.stringify(cell),
  );
  check(
    `${k} is not a writable setting`,
    !schema.settings.some((x) => x.name === k) &&
      schema.oldKeys.some((o) => o.key === k || o.name === k),
  );
  check(`the mode table in 15-modes.sh names ${k}`, modeTable.includes(k));
}

console.log("== D5: every image the docs show exists, and every image is shown ==");
const docFiles = [
  "README.md",
  "quickstart.md",
  ...readdirSync(resolve(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
];
const shown = new Set();
for (const f of docFiles) {
  for (const m of read(f).matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const [, alt, src] = m;
    if (/^https?:/.test(src)) continue;
    const abs = resolve(ROOT, dirname(f), src);
    shown.add(relative(ROOT, abs));
    check(`${f}: ${src} exists`, existsSync(abs));
    check(
      `${f}: ${src} has alt text that describes it`,
      alt.trim().length >= 20 && !/^(a |the )?screenshot\b/i.test(alt.trim()),
      `alt "${alt}"`,
    );
  }
}
const imgs = readdirSync(resolve(ROOT, "docs/img")).filter((f) =>
  /\.(png|jpe?g|gif|svg|webp)$/i.test(f),
);
check(`docs/img has images (${imgs.length})`, imgs.length > 0);
for (const f of imgs) check(`docs/img/${f} is shown in a doc`, shown.has(`docs/img/${f}`));

console.log();
if (fails.length === 0) {
  console.log(`docs-drift: all ${pass} passed`);
  process.exit(0);
}
console.log(`docs-drift: ${fails.length} FAILED (of ${pass + fails.length})`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(1);
