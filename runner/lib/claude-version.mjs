#!/usr/bin/env node
/**
 * Which Claude Code CLI version will run an agent call — recorded per attempt in the
 * usage ledger and the delivery evidence, so a later quality metric can tell one CLI
 * release from the next.
 *
 *   node lib/claude-version.mjs <claude-bin>    → prints the version (one line)
 *
 * Resolution, cheapest and least intrusive first:
 *   1. a native install: the binary resolves to `…/versions/<version>`;
 *   2. an npm install: the binary resolves into a package whose package.json is the
 *      CLI's own (`@anthropic-ai/claude-code`), whose `version` is read;
 *   3. otherwise `<bin> --version`, bounded to 10 s, first line. A SHELL SCRIPT is not
 *      executed (a wrapper or a test stub, which may count or log every call): it
 *      reads `unknown (wrapper script)`.
 * Never throws and always exits 0: a version that cannot be read is `unknown`, never a
 * reason to fail a delivery (runner/CLAUDE.md: fail-soft).
 */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

const CLI_PACKAGE = "@anthropic-ai/claude-code";

/** Printable, single-line, bounded — the value lands in JSON and on a web page. */
export function cleanVersion(v) {
  const s = String(v ?? "")
    .split("\n")[0]
    .replace(/[^A-Za-z0-9 ._()+:-]/g, "")
    .trim()
    .slice(0, 80);
  return s || "unknown";
}

function onPath(bin, env) {
  if (isAbsolute(bin) || bin.includes("/")) return existsSync(bin) ? bin : null;
  for (const d of String(env.PATH || "").split(delimiter)) {
    if (!d) continue;
    const p = join(d, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

function firstLine(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, 128, 0);
    return buf.subarray(0, n).toString("latin1").split("\n")[0];
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** True for `#!/bin/sh`, `#!/usr/bin/env bash` and the like. */
export function isShellScript(file) {
  const l = firstLine(file);
  return /^#!/.test(l) && /\b(?:ba|z|da|k)?sh\b/.test(l);
}

export function claudeVersion(bin, env = process.env) {
  try {
    const found = onPath(bin || "claude", env);
    if (!found) return "unknown (not found)";
    let real = found;
    try {
      real = realpathSync(found);
    } catch {
      /* keep the unresolved path */
    }
    const native = real.match(/[\\/]versions[\\/]([0-9][0-9A-Za-z.+-]*)$/);
    if (native) return cleanVersion(native[1]);
    let dir = dirname(real);
    for (let i = 0; i < 4; i++) {
      const pj = join(dir, "package.json");
      if (existsSync(pj)) {
        try {
          const p = JSON.parse(readFileSync(pj, "utf8"));
          if (p && p.name === CLI_PACKAGE && p.version) return cleanVersion(p.version);
        } catch {
          /* not the CLI's package.json */
        }
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (isShellScript(real)) return "unknown (wrapper script)";
    const out = execFileSync(found, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    return cleanVersion(out);
  } catch {
    return "unknown";
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(claudeVersion(process.argv[2] || process.env.CLAUDE_BIN || "claude") + "\n");
}
