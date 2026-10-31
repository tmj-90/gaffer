#!/usr/bin/env node
// runner/test/lib/mktemp-lint.mjs — the static rule behind no-unchecked-mktemp.test.sh.
//
// External review #6: a test whose mktemp failed turned its empty WORK into the current
// directory and its EXIT trap removed the checkout it ran from. The rule, per file:
//
//   shell (.sh)
//     T1  every `VAR="$(mktemp …)"` (not `-u`), `VAR="$(gaffer_test_tmpdir …)"`, and
//         `VAR="$(fn)"` where fn is a function of the same file that calls mktemp, is
//         CHECKED: `|| exit|return|{` on the same line, or `gaffer_test_check_tmp "$VAR"`
//         (or `[ -n "$VAR" ] && [ -d "$VAR" ]`) within the next two lines;
//     T2  a mktemp whose result is not assigned to a variable (`"$(mktemp -d)/x"`,
//         an argument) is refused: nothing can check it;
//     T3  a temp ROOT variable (one of the above, or GAFFER_TEST_ISO) is never removed
//         with a bare `rm -rf "$VAR"`: it goes through `gaffer_test_rm_work`
//         (runner/test/lib/tmpdir.sh), which refuses ".", "/", $HOME, the start dir,
//         the repo root, their ancestors and anything outside a temp root.
//   node (.mjs)
//     M1  no direct `mkdtempSync(` call: `gafferMkdtemp` (runner/test/lib/tmpdir.mjs)
//         exits 70 with a clear message and refuses a result outside a temp root.
//
// Comment lines and heredoc bodies (stub scripts a test writes) are not the test's own
// code and are skipped. Usage: node mktemp-lint.mjs <file>... — prints
// `file:line: rule: message` per violation; exit 1 when there is any.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const out = [];
const report = (file, n, rule, msg) => out.push(`${file}:${n}: ${rule}: ${msg}`);

function lintMjs(file, text) {
  if (basename(file) === "tmpdir.mjs" || basename(file) === "mktemp-lint.mjs") return;
  text.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (/\bmkdtempSync\s*\(/.test(line))
      report(file, i + 1, "M1", "mkdtempSync( — use gafferMkdtemp from runner/test/lib/tmpdir.mjs");
  });
}

// The code lines of a shell file: [lineNo, text] with comments and heredoc bodies dropped.
function codeLines(text) {
  const lines = text.split("\n");
  const res = [];
  let delim = null;
  let dash = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (delim !== null) {
      if ((dash ? line.replace(/^\t+/, "") : line) === delim) delim = null;
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    res.push([i + 1, line]);
    // A heredoc opener (not a here-string `<<<`): its body starts on the next line.
    const m = line.match(/(^|[^<])<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\3/);
    if (m) {
      delim = m[4];
      dash = m[2] === "-";
    }
  }
  return res;
}

function lintSh(file, text) {
  if (basename(file) === "tmpdir.sh" || basename(file) === "no-unchecked-mktemp.test.sh") return;
  const code = codeLines(text);
  // Functions that create a temp path AND print it: their $(fn) result is a temp root.
  // Transitive (a function printing another temp function's result counts), to a fixpoint.
  const tempFns = new Set();
  for (let grew = true; grew;) {
    grew = false;
    const made_re = new RegExp(
      String.raw`([A-Za-z_][A-Za-z0-9_]*)="?\$\(\s*(?:mktemp\b(?![^)]*\s-u\b)|gaffer_test_tmpdir\b` +
        (tempFns.size ? `|(?:${[...tempFns].join("|")})\\b` : "") +
        ")",
    );
    for (let k = 0; k < code.length; k++) {
      const def = code[k][1].match(/^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{?/);
      if (!def || tempFns.has(def[1])) continue;
      const made = [];
      for (let j = k; j < code.length && j < k + 40; j++) {
        const l = code[j][1];
        const a = l.match(made_re);
        if (a) made.push(a[1]);
        if (
          made.some((v) =>
            new RegExp(String.raw`\b(echo|printf\s+'[^']*')\s+"?\$\{?${v}\}?"?\s*$`).test(l.trim()),
          )
        ) {
          tempFns.add(def[1]);
          grew = true;
          break;
        }
        if (/\}\s*(#.*)?$/.test(l)) break; // the body's closing brace (or a one-liner)
      }
    }
  }
  const tempVars = new Set(["GAFFER_TEST_ISO"]);
  const producer = new RegExp(
    String.raw`\$\(\s*(mktemp\b[^)]*|gaffer_test_tmpdir\b[^)]*` +
      (tempFns.size ? `|(?:${[...tempFns].join("|")})(?:\\s[^)]*)?` : "") +
      String.raw`)\)`,
    "g",
  );
  for (let k = 0; k < code.length; k++) {
    const [n, line] = code[k];
    for (const m of line.matchAll(producer)) {
      const inner = m[1];
      if (/^mktemp\b/.test(inner) && /\s-u\b/.test(inner)) continue; // a name, nothing created
      const before = line.slice(0, m.index);
      const asg = before.match(/([A-Za-z_][A-Za-z0-9_]*)="?$/);
      const after = line.slice(m.index + m[0].length);
      if (!asg) {
        report(
          file,
          n,
          "T2",
          `\`$(${inner.trim()})\` is not assigned to a variable that is then checked`,
        );
        continue;
      }
      const v = asg[1];
      // `"$(mktemp -d)/x"`: the path is built before anything can check the mktemp.
      if (!/^"?(\s|;|\||&|$)/.test(after)) {
        report(
          file,
          n,
          "T2",
          `\`$(${inner.trim()})\` is extended ("${after.split(/[\s;]/)[0]}") before it can be checked`,
        );
        continue;
      }
      tempVars.add(v);
      if (/^"?\s*\|\|\s*(exit|return|\{)/.test(after)) continue;
      const esc = v.replace(/[$]/g, "\\$");
      const chk = new RegExp(String.raw`gaffer_test_check_tmp\s+"\$\{?${esc}\}?"`);
      const inl = new RegExp(
        String.raw`\[\s+-n\s+"\$\{?${esc}\}?"\s+\].*\[\s+-d\s+"\$\{?${esc}\}?"\s+\].*\b(exit|return)\b`,
      );
      let guarded = chk.test(after) || inl.test(after);
      for (let j = k + 1; !guarded && j < code.length && j <= k + 2; j++) {
        guarded = chk.test(code[j][1]) || inl.test(code[j][1]);
      }
      if (!guarded)
        report(
          file,
          n,
          "T1",
          `${v} is not checked after it is created — add \`gaffer_test_check_tmp "$${v}" || exit 70\``,
        );
    }
  }
  // T3: bare rm -rf of a temp root.
  const rmRe =
    /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*(?:\s+-[a-zA-Z]+)*|-[a-zA-Z]+\s+-[rR])\s+([^;|&)']*)/g;
  for (const [n, line] of code) {
    for (const m of line.matchAll(rmRe)) {
      for (const tok of m[1].trim().split(/\s+/)) {
        const t =
          tok.match(/^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/) ||
          tok.match(/^"?\$\(dirname\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\)"?$/);
        if (t && tempVars.has(t[1]))
          report(
            file,
            n,
            "T3",
            `\`rm -rf\` of the temp root $${t[1]} — use gaffer_test_rm_work "$${t[1]}"`,
          );
      }
    }
  }
}

for (const file of process.argv.slice(2)) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (file.endsWith(".mjs")) lintMjs(file, text);
  else lintSh(file, text);
}
if (out.length) {
  process.stdout.write(out.join("\n") + "\n");
  process.exit(1);
}
