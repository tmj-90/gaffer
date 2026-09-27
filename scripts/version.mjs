#!/usr/bin/env node
// Release versioning — one version train for the workspace.
//
//   node scripts/version.mjs <x.y.z>        set every package to x.y.z and cut the
//                                           CHANGELOG's [Unreleased] into [x.y.z] - <today>
//   node scripts/version.mjs --check <tag>  exit 1 unless <tag> (vX.Y.Z) matches the
//                                           root package version (the release workflow's gate)
//
// The root package.json and packages/*/package.json move together so a release
// tag names exactly one version everywhere (the SBOM, the image label, the
// tarballs). Nothing is committed or tagged here — see docs/RELEASING.md.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const args = process.argv.slice(2);

function packageFiles() {
  const files = [path.join(ROOT, "package.json")];
  for (const d of readdirSync(path.join(ROOT, "packages"))) {
    const p = path.join(ROOT, "packages", d, "package.json");
    try {
      readFileSync(p);
      files.push(p);
    } catch {
      /* not a package */
    }
  }
  return files;
}

export function rootVersion() {
  return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

/** Exit 1 unless the tag names the root version exactly. */
export function checkTag(tag) {
  const v = String(tag)
    .replace(/^refs\/tags\//, "")
    .replace(/^v/, "");
  const root = rootVersion();
  if (v !== root) {
    console.error(`version: tag ${tag} does not match package.json version ${root}`);
    return false;
  }
  return true;
}

/** Set every package.json version and cut the changelog. Returns the touched files. */
export function setVersion(
  version,
  { today = new Date().toISOString().slice(0, 10), root = ROOT } = {},
) {
  if (!SEMVER.test(version)) throw new Error(`version: '${version}' is not a semver version`);
  const touched = [];
  const files =
    root === ROOT
      ? packageFiles()
      : [
          path.join(root, "package.json"),
          ...readdirSync(path.join(root, "packages")).map((d) =>
            path.join(root, "packages", d, "package.json"),
          ),
        ];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    // Textual replace of the top-level "version" line so formatting/key order survive.
    const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
    if (next === text && !text.includes(`"version": "${version}"`))
      throw new Error(`version: no "version" field in ${f}`);
    writeFileSync(f, next);
    touched.push(f);
  }
  const cl = path.join(root, "CHANGELOG.md");
  const changelog = readFileSync(cl, "utf8");
  if (!changelog.includes("## [Unreleased]"))
    throw new Error("version: CHANGELOG.md has no [Unreleased] section");
  writeFileSync(
    cl,
    changelog.replace("## [Unreleased]", `## [Unreleased]\n\n## [${version}] - ${today}`),
  );
  touched.push(cl);
  return touched;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (args[0] === "--check") {
    if (!args[1]) {
      console.error("usage: version.mjs --check <tag>");
      process.exit(2);
    }
    process.exit(checkTag(args[1]) ? 0 : 1);
  }
  if (!args[0]) {
    console.error("usage: version.mjs <x.y.z> | --check <tag>");
    process.exit(2);
  }
  const touched = setVersion(args[0]);
  for (const f of touched) console.log(`updated ${path.relative(ROOT, f)}`);
  console.log(
    `\nnext: review the diff, commit "release: v${args[0]}", then\n  git tag -a v${args[0]} -m "v${args[0]}" && git push origin v${args[0]}`,
  );
}
