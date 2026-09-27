#!/usr/bin/env node
// Software bill of materials — CycloneDX 1.5 JSON for the whole workspace.
//
// Derived from the installed dependency graph (`pnpm list --prod --depth Infinity`)
// plus each package's own package.json (license, description), so the SBOM
// describes exactly what ships: the three workspace packages and every runtime
// dependency they resolve to, with purls, resolved tarball URLs and the
// dependency graph. Dev-only dependencies are excluded. Deterministic: sorted
// output, no timestamps unless --timestamp is passed (the release workflow does).
//
//   node scripts/sbom.mjs [--out <file>] [--timestamp]
//
// No dependencies: pnpm's own JSON is the only input. The release workflow
// attaches the result to the GitHub release next to the package tarballs.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx === -1 ? null : path.resolve(args[outIdx + 1]);
const WITH_TIMESTAMP = args.includes("--timestamp");

const rootPkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** pnpm's per-project dependency tree, production deps only. */
function pnpmList() {
  const raw = execFileSync("pnpm", ["list", "-r", "--json", "--depth", "Infinity", "--prod"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function purl(name, version) {
  // pkg:npm/%40scope/name@version — the scope's @ is percent-encoded per the purl spec.
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}

/** package.json `license` in its several historical shapes → SPDX ids. */
function licensesOf(pkg) {
  const out = [];
  const push = (v) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (v && typeof v === "object" && typeof v.type === "string") out.push(v.type.trim());
  };
  if (Array.isArray(pkg.license)) pkg.license.forEach(push);
  else push(pkg.license);
  if (Array.isArray(pkg.licenses)) pkg.licenses.forEach(push);
  return [...new Set(out)].map((id) =>
    /[\s()]/.test(id) ? { expression: id } : { license: { id } },
  );
}

const components = new Map(); // bom-ref → component
const edges = new Map(); // bom-ref → Set(bom-ref)

function readPkgJson(p) {
  try {
    return JSON.parse(readFileSync(path.join(p, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

function addComponent(name, version, dir, resolved, type) {
  const ref = purl(name, version);
  if (components.has(ref)) return ref;
  const pkg = dir ? readPkgJson(dir) : {};
  const c = {
    type,
    "bom-ref": ref,
    name,
    version,
    purl: ref,
  };
  if (pkg.description) c.description = String(pkg.description);
  const lic = licensesOf(pkg);
  if (lic.length) c.licenses = lic;
  const refs = [];
  if (resolved) refs.push({ type: "distribution", url: resolved });
  const repo =
    pkg.repository && (typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url);
  if (repo) refs.push({ type: "vcs", url: String(repo) });
  if (refs.length) c.externalReferences = refs;
  components.set(ref, c);
  edges.set(ref, new Set());
  return ref;
}

function walk(depsObj, parentRef) {
  for (const [name, d] of Object.entries(depsObj || {})) {
    const version = String(d.version || "");
    if (!version) continue;
    const isWorkspace =
      version.startsWith("link:") ||
      (d.resolved === undefined && d.path && d.path.startsWith(path.join(ROOT, "packages")));
    let ref;
    if (isWorkspace) {
      const wp = readPkgJson(d.path);
      ref = addComponent(
        wp.name || name,
        wp.version || version.replace(/^link:/, ""),
        d.path,
        null,
        "library",
      );
    } else {
      ref = addComponent(name, version, d.path, d.resolved, "library");
    }
    edges.get(parentRef).add(ref);
    walk(d.dependencies, ref);
  }
}

const projects = pnpmList();
const workspaceRefs = [];
for (const proj of projects) {
  if (proj.path === ROOT) continue; // the private root only aggregates
  const ref = addComponent(proj.name, proj.version, proj.path, null, "library");
  workspaceRefs.push(ref);
  walk(proj.dependencies, ref);
}

const appRef = purl(rootPkg.name, rootPkg.version);
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    ...(WITH_TIMESTAMP ? { timestamp: new Date().toISOString() } : {}),
    tools: [{ vendor: "gaffer", name: "scripts/sbom.mjs", version: rootPkg.version }],
    component: {
      type: "application",
      "bom-ref": appRef,
      name: rootPkg.name,
      version: rootPkg.version,
      description:
        rootPkg.description || "Gaffer — the software factory: control plane, runner, memory.",
      licenses: licensesOf(rootPkg),
      purl: appRef,
      externalReferences: [
        {
          type: "vcs",
          url: String(
            (rootPkg.repository && rootPkg.repository.url) || "https://github.com/tmj-90/gaffer",
          ),
        },
      ],
    },
  },
  components: [...components.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"])),
  dependencies: [
    { ref: appRef, dependsOn: [...workspaceRefs].sort() },
    ...[...edges.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ref, set]) => ({ ref, dependsOn: [...set].sort() })),
  ],
};

const text = `${JSON.stringify(bom, null, 2)}\n`;
if (OUT) {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.error(`sbom: ${bom.components.length} components → ${path.relative(ROOT, OUT)}`);
} else {
  process.stdout.write(text);
}
