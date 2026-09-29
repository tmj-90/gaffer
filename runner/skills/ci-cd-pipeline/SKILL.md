---
name: ci-cd-pipeline
description: Use when setting up CI for a new project, refactoring existing pipelines, migrating between platforms, or standardising deployment workflows. Triggers on "set up CI/CD", "GitHub Actions", "GitLab CI", "pipeline for this repo", "deployment workflow", or "why is CI slow".
stack: []
area: devops
---

# Build pragmatic CI/CD pipelines

A pipeline runs the repo's own commands, fast, with the least privilege that works, and
deploys one immutable artifact through environments. It runs untrusted code (every pull
request), so it is also an attack surface: follow GitHub's "Secure use" guidance for
Actions and SLSA for build provenance. For a red pipeline, use `debug-failing-ci` instead.

## Procedure

1. **Detect the real commands.** Read `package.json` scripts, `Makefile`, `pyproject.toml`,
   `go.mod`, `Cargo.toml`, `pom.xml`/`build.gradle`, the lockfile, and any existing
   workflow. Extract the exact lint, typecheck, test and build commands; `search_lore` for
   CI conventions. Never invent a command; if a stage has no command, omit the stage.
2. **Order the workflow's stages cheap-to-expensive** (you write these; you never run
   the install yourself): install (lockfile-exact: `npm ci`,
   `pnpm install --frozen-lockfile`, `pip install -r` with hashes, `go mod download`) →
   lint/typecheck → unit tests → integration tests → build → scan → deploy. Fail fast;
   parallelise independent jobs.
3. **Make tests gate.** No `continue-on-error: true`, no `|| true`, no skipped suites on the
   test job. Run the integration and concurrency tests the repo has — a green pipeline that
   skips them is how concurrent-writer data loss shipped twice in live runs.
4. **Harden the workflow (GitHub Actions):**
   - Top-level `permissions: contents: read`; grant more per job only where needed
     (`packages: write` to publish, `id-token: write` only on the deploy job).
   - Pin every third-party action to a full-length commit SHA with the tag as a comment:
     `uses: actions/checkout@<40-char-sha> # v4.2.2`. Add a Dependabot entry for
     `package-ecosystem: github-actions` so pins get updated.
   - Never interpolate untrusted context into `run:` — `github.event.pull_request.title`,
     `.body`, `github.head_ref`, issue/comment bodies, commit messages. Pass via `env:` and
     quote: `env: TITLE: ${{ github.event.pull_request.title }}` then `"$TITLE"`.
   - Use `pull_request`, not `pull_request_target`, for building PR code. Never check out
     PR head code in a `pull_request_target` or `workflow_run` job.
   - `actions/checkout` with `persist-credentials: false` unless the job must push.
   - Cloud access via OIDC federation, not long-lived keys; restrict the cloud trust policy
     to the repo and the protected environment (`sub` claim).
   - Secrets only from the secret store, one secret per value (no JSON blobs — redaction
     fails); register derived secrets with `::add-mask::`.
5. **Serialise deploys.** `concurrency: { group: deploy-<env>, cancel-in-progress: false }`
   on deploy jobs so two runs never deploy the same environment at once; use
   `cancel-in-progress: true` only for PR validation. Production deploys use a protected
   `environment:` with required reviewers. Set `timeout-minutes` on every job.
6. **Build once, promote the digest.** Build the artifact/image once, tag it by commit SHA,
   deploy that exact digest to staging and then production. For release artifacts, emit
   signed build provenance (e.g. `actions/attest-build-provenance`) — on hosted runners
   this reaches SLSA Build L2.
7. **Cache by lockfile hash** (`actions/setup-node` `cache:`, or `actions/cache` keyed on
   `hashFiles('**/pnpm-lock.yaml')`). A cold cache must still produce a correct build.
8. **GitLab CI equivalents:** `rules:` instead of `only/except`; `resource_group` to
   serialise deploys; `id_tokens:` for OIDC; protected, masked variables; images pinned by
   digest; `interruptible: true` only on validation jobs.
9. **Verify and evidence** (below) with the `record-evidence` skill, then stop. You cannot
   push or trigger CI, so the workflow first runs only after the branch leaves the
   factory (the runner pushes and opens a PR only when PR creation is enabled). Say so in
   the evidence rather than claiming a green run.

## Verification

- `actionlint` (GitHub) or `gitlab-ci-lint`/`glab ci lint` if already installed; otherwise
  parse the YAML with an available parser and record that the linter was not run. Do not
  install tools.
- Run every lint, typecheck, test and build command the workflow runs, locally, in the
  same order (skip install and deploy steps — no dependency installs); record the output.
- Grep checks: `grep -nE 'uses: +[^./][^@]*@' .github/workflows/* | grep -vE '@[0-9a-f]{40}'`
  returns nothing (every remote action pinned to a SHA); `grep -n '\${{ *github.event' .github/workflows/*`
  shows no hits inside `run:` blocks; every workflow has a `permissions:` block.

## Review checklist (concrete defects only)

- A stage runs a command that does not exist in the repo, or the test job can pass while
  tests fail.
- Missing top-level `permissions:` or a write scope not needed by that job.
- Third-party action pinned to a tag/branch; untrusted context inside `run:`.
- `pull_request_target`/`workflow_run` job that checks out or executes PR code.
- Long-lived cloud keys where OIDC is available; secrets echoed or stored as structured
  blobs.
- Deploy job without a concurrency group, or production deploy without a protected
  environment.

## Capture lore

Pipeline structure, deploy targets, required checks and environment promotion policy are
high-value lore: call `suggest_lore` with `tags: [ci-cd, pipeline, deploy]`.
