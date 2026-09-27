#!/usr/bin/env node
// Build provenance — an in-toto Statement (v1) with an SLSA Provenance v1
// predicate for the release artifacts, built from the GitHub Actions run context.
//
//   node scripts/provenance.mjs --out <file> <artifact>...
//
// Subjects are the artifacts' sha256 digests; the predicate records the source
// repository + commit, the workflow that built them, the runner and the run id,
// so a consumer can tie every tarball, SBOM and checksum file on a release back
// to the exact commit and workflow run. HONEST LIMIT: this statement is
// UNSIGNED. It is verifiable against the release's public run logs, not
// cryptographically. Signing it with GitHub Artifact Attestations
// (actions/attest-build-provenance → Sigstore) is the documented follow-up once
// that action's release is vetted and pinned like every other action here.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
if (outIdx === -1 || args.length < 3) {
  console.error("usage: provenance.mjs --out <file> <artifact>...");
  process.exit(2);
}
const OUT = path.resolve(args[outIdx + 1]);
const artifacts = args.filter((_, i) => i !== outIdx && i !== outIdx + 1);

export function statementFor(files, env = process.env, now = new Date()) {
  const subject = files.map((f) => ({
    name: path.basename(f),
    digest: { sha256: createHash("sha256").update(readFileSync(f)).digest("hex") },
  }));
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const repo = env.GITHUB_REPOSITORY || "tmj-90/gaffer";
  const sha = env.GITHUB_SHA || "";
  const ref = env.GITHUB_REF || "";
  const workflow = env.GITHUB_WORKFLOW_REF || `${repo}/.github/workflows/release.yml@${ref}`;
  const runId = env.GITHUB_RUN_ID || "";
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject,
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref,
            repository: `${server}/${repo}`,
            path: workflow.split("@")[0].replace(`${repo}/`, ""),
          },
        },
        internalParameters: {
          github: {
            event_name: env.GITHUB_EVENT_NAME || "",
            repository_id: env.GITHUB_REPOSITORY_ID || "",
            runner_environment: env.RUNNER_ENVIRONMENT || "",
          },
        },
        resolvedDependencies: [{ uri: `git+${server}/${repo}@${ref}`, digest: { gitCommit: sha } }],
      },
      runDetails: {
        builder: {
          id: `${server}/${env.GITHUB_ACTION_REPOSITORY || repo}/.github/workflows/release.yml`,
        },
        metadata: {
          invocationId: runId
            ? `${server}/${repo}/actions/runs/${runId}/attempts/${env.GITHUB_RUN_ATTEMPT || "1"}`
            : "",
          finishedOn: now.toISOString(),
        },
      },
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stmt = statementFor(artifacts);
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(stmt, null, 2)}\n`);
  console.error(`provenance: ${stmt.subject.length} subject(s) → ${OUT} (unsigned statement)`);
}
