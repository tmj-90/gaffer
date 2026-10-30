#!/usr/bin/env node
// render.mjs — render the launchd scheduled-run template with this machine's real
// paths, so the agent launchd starts can find node, git and claude.
//
// launchd starts a job with a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin). node is
// almost never there (Homebrew puts it in /opt/homebrew/bin or /usr/local/bin, nvm
// and volta under $HOME), so an unrendered or hand-sed'd plist died on its first
// control-plane call ("SETUP: could not register factory agent"). This renderer
// writes an EnvironmentVariables.PATH that starts with the directory of the node
// running it (process.execPath), then the directories holding `claude` and `git` on
// the caller's PATH, then the usual system locations.
//
//   node runner/launchd/render.mjs [--repo DIR] [--data DIR] [--path PATH] [--out FILE]
//
//   --repo  Gaffer checkout root (default: the checkout this file lives in)
//   --data  factory state dir (default: $GAFFER_DATA, else <repo>/.gaffer)
//   --path  use this PATH verbatim instead of the resolved one
//   --out   write the plist here (default: stdout)

import { accessSync, constants, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, "com.gaffer.factory.plist.template");
const SYSTEM_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function usage(msg) {
  if (msg) console.error(`render.mjs: ${msg}`);
  console.error(
    "usage: node runner/launchd/render.mjs [--repo DIR] [--data DIR] [--path PATH] [--out FILE]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = { "--repo": "repo", "--data": "data", "--path": "path", "--out": "out" }[a];
    if (!key) usage(`unknown argument '${a}'`);
    const v = argv[++i];
    if (v === undefined || v === "") usage(`${a} needs a value`);
    opts[key] = v;
  }
  return opts;
}

/** The directory holding an executable `name` on `pathVar`, or null. */
function whichDir(name, pathVar) {
  for (const d of (pathVar || "").split(delimiter)) {
    if (!d || !isAbsolute(d)) continue;
    try {
      accessSync(join(d, name), constants.X_OK);
      return d;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** node's dir, then claude's and git's, then the system dirs — deduplicated. */
export function resolvePath(env = process.env, execPath = process.execPath) {
  const dirs = [dirname(execPath)];
  for (const tool of ["claude", "git"]) {
    const d = whichDir(tool, env.PATH);
    if (d) dirs.push(d);
  }
  dirs.push(...SYSTEM_DIRS);
  return [...new Set(dirs)].join(":");
}

const xmlEscape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Split the template into its leading header comment (kept verbatim) and the body
 * (rendered). The header documents the placeholders by name; substituting there put
 * the real path into an XML comment, and a value containing "--" (my--data, a PATH
 * entry like /opt/a--b) is not allowed inside one, so the plist failed to parse.
 */
function splitHeader(tpl) {
  const open = tpl.indexOf("<!--");
  const plist = tpl.indexOf("<plist");
  if (open === -1 || (plist !== -1 && open > plist)) return { head: "", body: tpl };
  const close = tpl.indexOf("-->", open + 4);
  if (close === -1) throw new Error("template header comment is not closed");
  return { head: tpl.slice(0, close + 3), body: tpl.slice(close + 3) };
}

/** Comments in `xml` whose text contains "--" (invalid XML); empty when well-formed. */
export function badComments(xml) {
  return [...xml.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]).filter((c) => c.includes("--"));
}

export function render({ repo, data, path }) {
  const { head, body } = splitHeader(readFileSync(TEMPLATE, "utf8"));
  return (
    head +
    body
      .split("__GAFFER_REPO__")
      .join(xmlEscape(repo))
      .split("__GAFFER_DATA__")
      .join(xmlEscape(data))
      .split("__GAFFER_PATH__")
      .join(xmlEscape(path))
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const opts = parseArgs(process.argv.slice(2));
  const repo = resolve(opts.repo || join(HERE, "..", ".."));
  const data = resolve(opts.data || process.env.GAFFER_DATA || join(repo, ".gaffer"));
  const path = opts.path || resolvePath();
  try {
    accessSync(join(repo, "runner", "loop.sh"), constants.R_OK);
  } catch {
    usage(`${repo} is not a Gaffer checkout (no runner/loop.sh)`);
  }
  const out = render({ repo, data, path });
  // Only the header comment may still name placeholders; the plist itself may not.
  if (/__GAFFER_[A-Z]+__/.test(out.slice(out.indexOf("<plist"))))
    usage("template has an unknown placeholder left after rendering");
  // Fail closed rather than write a plist launchd cannot load.
  if (badComments(out).length > 0)
    usage("rendered plist has an XML comment containing '--' (a value landed in a comment)");
  if (opts.out) writeFileSync(opts.out, out);
  else process.stdout.write(out);
}
