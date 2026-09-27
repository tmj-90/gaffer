# Releasing Gaffer

A release is a git tag. Pushing `vX.Y.Z` runs `.github/workflows/release.yml`, which
builds and tests the tagged commit and publishes, from that commit alone:

| Artifact                                  | Where                                                            |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Package tarballs (`npm pack` output)      | GitHub release assets: `dispatch-X.Y.Z.tgz`, `crew-…`, `memory-mcp-…` |
| CycloneDX 1.5 SBOM                        | `gaffer-X.Y.Z.cdx.json` — every runtime dependency with purl, license, resolved URL and the dependency graph (`scripts/sbom.mjs`) |
| Checksums                                 | `SHA256SUMS`                                                     |
| Provenance statement (in-toto / SLSA v1)  | `gaffer-X.Y.Z.provenance.json` — subjects (sha256 of each asset), source commit, workflow, run id (`scripts/provenance.mjs`) |
| Container image                           | `ghcr.io/tmj-90/gaffer:X.Y.Z` and `:latest`, with BuildKit's SBOM + provenance attestations and OCI source/revision/version labels |
| Release notes                             | The version's `CHANGELOG.md` section, verbatim (`scripts/release-notes.mjs`) |

## Cutting a release

1. Make sure `main` is green and the `[Unreleased]` section of `CHANGELOG.md` says
   what shipped.
2. Set the version everywhere and cut the changelog:

   ```sh
   node scripts/version.mjs 0.2.0
   git diff                              # root + packages/*/package.json, CHANGELOG.md
   git commit -am "release: v0.2.0"
   git push origin main
   ```

   All packages move together — one version train — so a tag names one version in
   the SBOM, the image label and every tarball.

3. Tag and push the tag:

   ```sh
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

   The workflow refuses a tag whose version differs from `package.json`
   (`scripts/version.mjs --check`), so a stray tag cannot publish a mismatch.

4. Watch the `Release` run. It ends with the GitHub release created
   (`gh release create --verify-tag`) and the image pushed.

## Installing a release

```sh
# the dashboard + runner from the published image
GAFFER_IMAGE=ghcr.io/tmj-90/gaffer:0.2.0 docker compose up -d --no-build

# or a package tarball, e.g. the control plane CLI
npm install -g https://github.com/tmj-90/gaffer/releases/download/v0.2.0/dispatch-0.2.0.tgz
sha256sum -c SHA256SUMS --ignore-missing   # after downloading the assets you use
```

## Verifying a release

- **Checksums:** `sha256sum -c SHA256SUMS` against the downloaded assets.
- **Provenance:** the statement's `subject` digests must equal the assets' sha256;
  `predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit` is the
  tagged commit and `runDetails.metadata.invocationId` links the public run.
- **Image:** `docker buildx imagetools inspect ghcr.io/tmj-90/gaffer:X.Y.Z --format '{{ json .Provenance }}'`
  (and `.SBOM`) prints the attestations BuildKit attached at build time.
- **SBOM:** feed `gaffer-X.Y.Z.cdx.json` to any CycloneDX consumer (Dependency-Track,
  `grype sbom:…`, `trivy sbom …`).

## Honest limits

- The provenance statement for the tarballs is **unsigned**. It is verifiable
  against the public workflow run, not cryptographically. Signing it through
  GitHub Artifact Attestations (`actions/attest-build-provenance`, Sigstore) is
  the intended next step once that action's release is vetted and pinned by SHA
  like every other action in this repository. The image's attestations are
  BuildKit-generated and stored in the registry.
- Packages are published as **GitHub release tarballs, not to npm**. Their names
  (`dispatch`, `crew`, `memory-mcp`) are unscoped and generic; publishing to the
  npm registry means claiming a scope and renaming (`@<scope>/dispatch`, …), which
  touches the workspace imports and the docs. Decision: keep the current names
  until a scope is claimed; the tarball install path above works today.
