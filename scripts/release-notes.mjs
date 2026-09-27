#!/usr/bin/env node
// Release notes — the CHANGELOG section for one version, as Markdown on stdout.
//
//   node scripts/release-notes.mjs <x.y.z>   (or vX.Y.Z)
//
// The release workflow feeds this to `gh release create --notes-file`, so the
// GitHub release body is exactly the changelog entry: one source of truth.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function releaseNotes(
  version,
  changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"),
) {
  const v = String(version).replace(/^v/, "");
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^## \\[${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`).test(l),
  );
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return body.length ? `${body}\n` : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: release-notes.mjs <version>");
    process.exit(2);
  }
  const notes = releaseNotes(version);
  if (notes === null) {
    console.error(`release-notes: no CHANGELOG section for ${version}`);
    process.exit(1);
  }
  process.stdout.write(notes);
}
