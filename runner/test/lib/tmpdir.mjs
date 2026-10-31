// runner/test/lib/tmpdir.mjs — the Node side of runner/test/lib/tmpdir.sh.
//
// gafferMkdtemp(prefix) is mkdtempSync(prefix) for tests, with two guarantees: a failure
// (TMPDIR missing, unwritable, full) stops the test with a clear message and exit 70
// instead of a stack trace, and the directory it returns is an absolute path strictly
// under a temp root (os.tmpdir(), $TMPDIR or /tmp), so a relative or odd TMPDIR can
// never point a test's fixtures, or its cleanup, at the checkout it runs from.
// runner/test/no-unchecked-mktemp.test.sh refuses a direct mkdtempSync( in the tests.
import { mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, sep } from "node:path";

function refuse(why) {
  const name = basename(process.argv[1] || "test");
  process.stderr.write(
    `${name}: refusing to run: ${why}; TMPDIR=${process.env.TMPDIR ?? "<unset>"} (nothing was deleted)\n`,
  );
  process.exit(70);
}

function tempRoots() {
  const roots = new Set();
  for (const r of [tmpdir(), process.env.TMPDIR, "/tmp"]) {
    if (!r || !isAbsolute(r)) continue;
    const t = r.length > 1 ? r.replace(/\/+$/, "") : r;
    if (t === "" || t === "/") continue;
    roots.add(t);
    try {
      roots.add(realpathSync(t));
    } catch {
      /* a missing root has no canonical form */
    }
  }
  return [...roots];
}

/** mkdtempSync(prefix), or a clear refusal (exit 70). */
export function gafferMkdtemp(prefix) {
  let dir;
  try {
    dir = mkdtempSync(prefix);
  } catch (e) {
    refuse(
      `mktemp failed: could not create a temp directory from "${prefix}" (${e?.code || e?.message || e})`,
    );
  }
  let canon = dir;
  try {
    canon = realpathSync(dir);
  } catch {
    /* keep the literal path */
  }
  const under = (p) => tempRoots().some((r) => p.startsWith(r + sep) && p.length > r.length + 1);
  if (!isAbsolute(dir) || !(under(dir) || under(canon))) {
    try {
      rmdirSync(dir); // empty: it was created a moment ago
    } catch {
      /* best effort */
    }
    refuse(
      `the temp directory "${dir}" is not under a temp root (${tempRoots().join(", ") || "none"})`,
    );
  }
  return dir;
}
