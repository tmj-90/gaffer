#!/usr/bin/env node
// =====================================================================
// The first-run docs (README, quickstart, SECURITY) must say what the code does.
// Each group pins one finding from the fresh-user audit against its source:
//   F-01 the unattended greenfield recipe is GAFFER_MODE=autonomous plus the
//        sandbox it requires, not DISPATCH_ALLOW_AGENT_APPROVE=1 alone (that leaves
//        REVIEW_MODE=human, so no reviewer ever runs)
//   F-02 the quickstart's dashboard step binds loopback; --lan is the opt-in and
//        says it is plain HTTP; SECURITY.md has a No TLS note
//   F-03 the Node floor is a hard prerequisite: no doc says a build works without it
//   F-07 no "still on a branch" note for the Match Day dashboard
//   F-08 no doc says GAFFER_MODE=strict adds the sandbox on top of autonomous
//   F-10 the strict-pack recipe covers every ready gate (--verify, approve-ready)
//   F-14 README and quickstart say how to change the dashboard port
//   F-19 README says how to put `gaffer` on PATH
//   F-20 the docs use the UI's sentence case for the Match Day panels
//   F-24 the quickstart's screen list names every nav entry
//   F-25 the README's Docker paragraph creates ./repos first
//   UI F-15 the README says how to get a read-only token
// Run: node runner/test/docs-first-run.test.mjs
// =====================================================================
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
/** The text from a heading line to the next heading of the same or higher level. */
function section(text, heading) {
  const at = text.indexOf(heading);
  if (at < 0) return "";
  const level = heading.match(/^#+/)[0].length;
  const rest = text.slice(at + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

const readme = read("README.md");
const quick = read("quickstart.md");
const security = read("SECURITY.md");
const features = read("docs/FEATURES.md");
const config = read("docs/CONFIG.md");
const app = read("packages/dispatch/src/api/web/app.js");

console.log("== F-01: the unattended greenfield recipe ==");
const gotchas = section(quick, "### Greenfield gotchas");
check("quickstart has the greenfield gotchas section", gotchas.length > 0);
check("the hands-off recipe sets GAFFER_MODE=autonomous", /GAFFER_MODE=autonomous/.test(gotchas));
check(
  "the hands-off recipe names the sandbox requirement it brings",
  /GAFFER_STRICT_REQUIRE/.test(gotchas) && /SANDBOX_PROVIDER=docker/.test(gotchas),
);
check(
  "no recipe sets DISPATCH_ALLOW_AGENT_APPROVE=1 on its own",
  !/set\s+`DISPATCH_ALLOW_AGENT_APPROVE=1`/.test(quick),
);

console.log("== F-02: the dashboard binds loopback unless you ask ==");
const step3 = section(quick, "## 3. Open the control room");
const firstBlock = (step3.match(/```bash\n([\s\S]*?)```/) || [])[1] || "";
check(
  "quickstart step 3's command is `runner/gaffer dashboard` without --lan",
  /^runner\/gaffer dashboard\s*$/m.test(firstBlock) && !/--lan/.test(firstBlock),
  firstBlock.trim(),
);
check(
  "quickstart warns that --lan is plain HTTP carrying the full token",
  /--lan/.test(step3) && /plain HTTP/i.test(step3) && /full token/i.test(step3),
);
check("SECURITY.md has a No TLS note", /\*\*No TLS/.test(security));

console.log("== F-03: the Node floor is a hard prerequisite ==");
check(
  "quickstart no longer says `pnpm install && pnpm -r build` works on its own",
  !/does that part on its own/.test(quick),
);
check("quickstart shows setup's refusal message", /is below Gaffer's floor/.test(quick));
check(
  "quickstart says npm_config_engine_strict=false does not get past setup",
  /npm_config_engine_strict=false/.test(quick),
);

console.log("== F-07: the Match Day dashboard is on main ==");
check("README has no 'still on a branch' note", !/still on a branch/i.test(readme));

console.log("== F-08: strict and autonomous set the same flags ==");
for (const [f, text] of [
  ["README.md", readme],
  ["quickstart.md", quick],
  ["docs/CONFIG.md", config],
  ["docs/FEATURES.md", features],
]) {
  check(
    `${f} does not say strict adds the sandbox on top of autonomous`,
    !/strict[^.]{0,40}adds[^.]{0,40}sandbox[^.]{0,30}on top/i.test(text) &&
      !/on top of autonomous/i.test(text),
  );
}

console.log("== F-10: the strict-pack recipe passes every ready gate ==");
const strictAt = quick.indexOf("Readying a ticket under the stricter policy packs");
const strictNote = strictAt < 0 ? "" : quick.slice(strictAt);
check("quickstart has the strict-pack note", strictAt >= 0);
const recipe = (strictNote.match(/```bash\n([\s\S]*?)```/) || [])[1] || "";
check(
  "the recipe creates the ticket with -p",
  /ticket create[^\n]*-p\s+factory_strict/.test(recipe),
);
check(
  "every criterion in the recipe carries --verify",
  /ac add/.test(recipe) &&
    recipe
      .split("\n")
      .filter((l) => /ac add/.test(l))
      .every((l) => /--verify/.test(l)),
);
check(
  "the recipe assigns a reviewer without --admin",
  /set-reviewer/.test(recipe) && !/--admin/.test(recipe),
);
check("the recipe covers regulated's approve-ready", /approve-ready/.test(recipe));
check(
  "the note names every gate code",
  [
    "DESCRIPTION_REQUIRED",
    "AC_VERIFICATION_REQUIRED",
    "REVIEWER_REQUIRED",
    "HUMAN_APPROVAL_REQUIRED",
  ].every((c) => strictNote.includes(c)),
);

console.log("== F-14: changing the dashboard port ==");
check("README says DISPATCH_API_PORT", /DISPATCH_API_PORT=/.test(readme));
check("quickstart says DISPATCH_API_PORT", /DISPATCH_API_PORT=/.test(quick));
check("quickstart names compose's GAFFER_PORT", /GAFFER_PORT/.test(quick));
check(
  "compose.yaml falls back to DISPATCH_API_PORT",
  /\$\{GAFFER_PORT:-127\.0\.0\.1:\$\{DISPATCH_API_PORT:-8787\}\}/.test(read("compose.yaml")),
);

console.log("== F-19: `gaffer` on PATH ==");
check("README shows an alias for runner/gaffer", /alias gaffer=/.test(readme));

console.log("== F-20: the docs use the UI's sentence case ==");
for (const [ui, wrong] of [
  ['"Team sheet"', /Team Sheet/],
  ['"Tactics board"', /Tactics Board/],
  ['"The gaffer\'s sign-off"', /Gaffer's Sign-off/],
]) {
  check(`app.js still titles the panel ${ui}`, app.includes(ui));
  for (const [f, text] of [
    ["README.md", readme],
    ["quickstart.md", quick],
    ["docs/FEATURES.md", features],
  ]) {
    check(`${f} has no ${wrong.source}`, !wrong.test(text));
  }
}

console.log("== F-24: the quickstart lists every nav screen ==");
const navBlock = app.slice(
  app.indexOf("const NAV = ["),
  app.indexOf("];", app.indexOf("const NAV = [")),
);
const labels = [...navBlock.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
check(`the nav has labels (${labels.length})`, labels.length > 0);
for (const l of labels) check(`quickstart lists **${l}**`, quick.includes(`**${l}**`));

console.log("== F-25: the README's Docker paragraph creates ./repos ==");
check("README has mkdir -p repos", /mkdir -p repos/.test(readme));

console.log("== UI F-15: how to get a read-only token ==");
check("README names print-read-token", /print-read-token/.test(readme));
check("README names `principal create … --read`", /principal create \S+ --read/.test(readme));
check("README names Settings → Access", /Settings → Access/.test(readme));

console.log();
if (fails.length === 0) {
  console.log(`docs-first-run: all ${pass} passed`);
  process.exit(0);
}
console.log(`docs-first-run: ${fails.length} FAILED (of ${pass + fails.length})`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(1);
