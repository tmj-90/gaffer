#!/usr/bin/env node
// =====================================================================
// The untrusted-text escaper on the runner side (F3). Matching the closing tag could
// not win: a soft hyphen, an invisible character inside the word "untrusted" or a
// Cyrillic look-alike slipped past the old delimiter regex. Every `<` of untrusted text
// is now escaped to `&lt;`. Proves, against the vector file the TypeScript packages
// read too (runner/test/fixtures/quarantine-vectors.json):
//   - runner/lib/untrusted.mjs escapeUntrusted maps every vector exactly, idempotently
//   - quarantine() (and agent-io's re-export) leaves no `<` between the tags, so each
//     envelope has exactly one opener and one closer, in single-line and block form
//   - wrapping a wrapped value escapes the inner tags and nothing else
//   - the shell door (gaffer_quarantine through json-tool.mjs) gives the same bytes
//   - the security notice says what &lt; means
// Run: node runner/test/untrusted-escape.test.mjs
// =====================================================================
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, "..", "lib");
const { vectors } = JSON.parse(
  readFileSync(resolve(HERE, "fixtures", "quarantine-vectors.json"), "utf8"),
);

let passed = 0;
const failures = [];
const assert = (label, cond) => {
  if (cond) passed += 1;
  else failures.push(label);
};
const count = (hay, needle) => hay.split(needle).length - 1;

let mod = null;
try {
  mod = await import(resolve(LIB, "untrusted.mjs"));
} catch (e) {
  failures.push(`runner/lib/untrusted.mjs loads (${e.message})`);
}
const agentIo = await import(resolve(LIB, "agent-io.mjs"));

if (mod) {
  for (const v of vectors) {
    assert(`escapeUntrusted maps vector "${v.name}"`, mod.escapeUntrusted(v.input) === v.escaped);
    assert(
      `escapeUntrusted is idempotent on "${v.name}"`,
      mod.escapeUntrusted(v.escaped) === v.escaped,
    );
  }
  assert("null and undefined escape to the empty string", mod.escapeUntrusted(null) === "");
  assert(
    "the notice says &lt; inside the tags is a literal <",
    /&lt; inside these tags is a literal </.test(mod.QUARANTINE_NOTICE),
  );
  assert("the escape note is exported on its own", typeof mod.QUARANTINE_ESCAPE_NOTE === "string");
}

for (const [label, q] of [
  ["untrusted.mjs quarantine", mod?.quarantine],
  ["agent-io quarantine", agentIo.quarantine],
]) {
  if (typeof q !== "function") {
    failures.push(`${label} is a function`);
    continue;
  }
  for (const v of vectors) {
    for (const opts of [{}, { singleLine: true }, { block: true }]) {
      const w = q("ticket-title", v.input, opts);
      const inner = w.slice("<untrusted-ticket-title>".length, -"</untrusted-ticket-title>".length);
      assert(`${label} ${JSON.stringify(opts)} "${v.name}": no < inside`, !inner.includes("<"));
      assert(
        `${label} ${JSON.stringify(opts)} "${v.name}": one opener, one closer`,
        count(w, "<untrusted-ticket-title>") === 1 && count(w, "</untrusted-ticket-title>") === 1,
      );
    }
  }
  const twice = q("outer", q("inner", "a<b"));
  assert(
    `${label}: double wrapping escapes the inner tags only`,
    twice === "<untrusted-outer>&lt;untrusted-inner>a&lt;b&lt;/untrusted-inner></untrusted-outer>",
  );
}

// The shell door: gaffer_quarantine pipes through json-tool.mjs.
for (const v of vectors) {
  for (const mode of ["multi", "single"]) {
    let outText;
    try {
      outText = execFileSync(
        "bash",
        ["-c", `. "${LIB}/quarantine.sh"; gaffer_quarantine t "$1" ${mode}`, "x", v.input],
        { encoding: "utf8" },
      );
    } catch (e) {
      failures.push(`gaffer_quarantine runs on "${v.name}" (${e.message})`);
      continue;
    }
    const want =
      mode === "single"
        ? `<untrusted-t>${v.escaped.replace(/\s+/g, " ").trim()}</untrusted-t>`
        : `<untrusted-t>${v.escaped}</untrusted-t>`;
    assert(`gaffer_quarantine ${mode} "${v.name}" matches the vector`, outText === want);
  }
}
const sh = execFileSync(
  "bash",
  ["-c", `. "${LIB}/quarantine.sh"; printf '%s' "$QUARANTINE_NOTICE"`],
  {
    encoding: "utf8",
  },
);
assert(
  "the shell QUARANTINE_NOTICE says what &lt; means",
  /&lt; inside these tags is a literal </.test(sh),
);
if (mod)
  assert("the shell notice and the module notice are the same text", sh === mod.QUARANTINE_NOTICE);

if (failures.length) {
  console.error(`FAIL untrusted-escape: ${failures.length} failed, ${passed} passed`);
  for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS untrusted-escape: ${passed} assertions`);
