---
name: docker-development
description: Use when optimising a Dockerfile, creating or improving docker-compose configurations, implementing multi-stage builds, auditing container security, or reducing image size. Triggers on "Dockerfile", "docker-compose", "container", "image size", "build cache", or "Docker best practices".
stack: [docker]
area: infra
---

# Smaller images. Faster builds. Secure containers.

Three concerns, in priority order: the container is safe (non-root, no secrets, pinned
inputs), it behaves correctly as PID 1 (signals, health), and it is small and cache-friendly.
Rules follow Docker's official "Building best practices" and Dockerfile reference.

## Reference pattern

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22.11-bookworm-slim@sha256:<digest> AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22.11-bookworm-slim@sha256:<digest> AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]
```

Replace `<digest>` with the real digest (`docker buildx imagetools inspect <image:tag>`);
if you cannot resolve it, pin the full version tag and say so in evidence.

## Procedure

1. **Read what exists.** `search_lore` for base-image, registry and scan conventions. Read
   the current Dockerfile, `.dockerignore`, compose files and the CI job that builds the
   image. Note how the app starts, its port, its health endpoint, and what it writes to
   disk.
2. **Pin inputs.** Base images by explicit version plus digest, never `latest`; the same
   base across stages where possible. Add a Dependabot `package-ecosystem: docker` entry if
   the repo uses Dependabot, so pins get refreshed.
3. **Split build from runtime.** Compilers, dev dependencies, package-manager caches and
   source stay in the build stage; runtime gets only the artifact. Prefer slim or
   distroless runtimes; a static binary can use `scratch`/distroless static.
4. **Order for cache.** Manifests and lockfile → install → source → build. Use
   `RUN --mount=type=cache` for package-manager caches. Keep `.dockerignore` tight: `.git`,
   `node_modules`, build output, test fixtures, `.env*`, keys.
5. **Harden.**
   - Non-root with a numeric UID/GID (`USER 10001:10001`) so Kubernetes `runAsNonRoot`
     can verify it; no `sudo`.
   - Build-time secrets only via `RUN --mount=type=secret,id=...`. Never `ARG`/`ENV` for
     secrets — build args are visible in `docker history`.
   - `apt-get update && apt-get install -y --no-install-recommends ... && rm -rf
     /var/lib/apt/lists/*` in one `RUN`; `set -o pipefail` before pipes (with bash).
   - `COPY`, not `ADD`, unless extracting a local tarball.
6. **Behave as PID 1.** Exec-form `CMD`/`ENTRYPOINT` (JSON array) so SIGTERM reaches the
   app; the app drains in-flight work on SIGTERM; use `docker run --init`/tini if it spawns
   children. Add a `HEALTHCHECK` (or the orchestrator's probe) that checks the app, not
   just the port.
7. **Compose.** Healthchecks on every service; `depends_on: { db: { condition:
   service_healthy } }`; named volumes for data; no secrets inline (use `secrets:` or
   environment injected at runtime — the safety hook blocks `.env*` files, so document
   required variables in the README or compose comments). Do not scale a service to more
   than one replica on a shared writable volume unless the app is proven safe for
   concurrent writers — temp-file name collisions and unsynchronised read-modify-write lost
   data in live runs.
8. **Verify** (below), evidence with the `record-evidence` skill, then stop.

## Verification

If `docker` is available:
- `docker build --check .` (build checks) then `docker build -t app:test .` succeeds.
- `docker image inspect -f '{{.Config.User}}' app:test` is non-empty and not `root`/`0`.
- `docker history --no-trunc app:test` shows no credentials or tokens.
- `docker run -d --read-only --tmpfs /tmp -p 3000:3000 app:test`, then the health endpoint
  answers; `docker stop` exits within the grace period (signals handled); remove the
  container afterwards (`docker rm -f`).
- Record image size before and after.
- `trivy image app:test` or `docker scout cves app:test` if installed: no fixable
  HIGH/CRITICAL.

If `docker` is unavailable, run `hadolint Dockerfile` if installed, walk the checklist
statically, and state in evidence which checks were not executed. Never install tools.

## Review checklist (concrete defects only)

- Runtime stage runs as root, or contains compilers/dev dependencies/source.
- Secret in `ARG`, `ENV`, a `COPY`ed file, or visible in history.
- Base image unpinned (`latest` or floating major) or different versions per stage by
  accident.
- Shell-form `CMD`/`ENTRYPOINT` for a long-running service (SIGTERM never reaches it).
- `apt-get update` in its own layer; missing `.dockerignore` so `.git`/`.env*` enter
  the context.
- Compose service scaled over a shared writable volume without concurrency safety.

## Capture lore

Base image choices, registry, UID convention and scan thresholds are high-value lore:
call `suggest_lore` with `tags: [docker, containers, infra]`.
