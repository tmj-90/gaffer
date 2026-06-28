---
name: docker-development
description: Use when optimising a Dockerfile, creating or improving docker-compose configurations, implementing multi-stage builds, auditing container security, or reducing image size. Triggers on "Dockerfile", "docker-compose", "container", "image size", "build cache", or "Docker best practices".
stack: [docker]
area: infra
---

# Smaller images. Faster builds. Secure containers.

Opinionated Docker workflow — turn bloated Dockerfiles into production-grade containers. Three concerns: size, speed (build cache), security.

## Multi-stage build pattern (every production image)

```dockerfile
# --- build stage ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# --- runtime stage ---
FROM node:22-alpine AS runtime
RUN addgroup -S app && adduser -S -G app app
WORKDIR /app
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
USER app
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

Key principles:
- Build tools and source code stay in the build stage; only the artifact ships.
- Non-root user (`USER app`) in the runtime stage.
- `.dockerignore` excludes `node_modules/`, `.git/`, `*.md`, test files.

## Layer caching discipline

1. Copy dependency manifests first (`package.json`, `pnpm-lock.yaml`) — before source code.
2. Run install — cache busts only on lockfile change.
3. Copy source — cache busts on any source change.
4. Build — always after source copy.

Violating this order invalidates cache on every source change.

## Security hardening

| Control | Implementation |
|---------|---------------|
| Non-root user | `addgroup/adduser` + `USER` directive |
| Read-only filesystem | `--read-only` flag at runtime; explicit tmpfs mounts where needed |
| No secrets in layers | Build args for values; never `ENV SECRET=...`; use runtime secrets injection |
| Minimal base image | `alpine` or `distroless`; never `latest` tag |
| Pin digest | `FROM node:22-alpine@sha256:...` for reproducibility |
| Scan at build | `docker scout` or `trivy` in CI; block on HIGH/CRITICAL CVEs |

## Steps

1. **Read the lore + existing Dockerfile.** `search_lore` for existing build conventions, base image choices, and registry. Extend; don't duplicate.
2. **Audit the current state.** Count layers; identify the base image and its size; check for build tools leaking into the runtime stage; look for secrets in `ENV` or `RUN` commands.
3. **Apply multi-stage build.** Separate build from runtime. If only one stage is needed (static binary), still use an explicit base and non-root user.
4. **Order for cache.** Dependencies before source; `COPY --link` where supported.
5. **Harden.** Non-root user; minimal runtime image; no secrets in layers; read-only where practical.
6. **Compose (if needed).** Health-check every service; use named volumes not bind mounts for data; keep `.env.example` in version control.
7. **Verify.** Build succeeds; image scan clean; container starts and passes health check; record evidence.

## Build / Test

- `docker build --no-cache` to verify reproducibility.
- `trivy image <name>` or `docker scout cves <name>` — zero HIGH/CRITICAL before shipping.
- `docker run --read-only --tmpfs /tmp` to verify read-only filesystem compatibility.
- Image size comparison: measure before and after; document the reduction.

## Review checklist

- **Multi-stage build** — build tools absent from runtime image.
- **Non-root user** — `USER` directive in runtime stage.
- **Dependency manifest first** — cache-friendly layer order.
- **No secrets in layers** — `docker history` shows no credentials.
- **Base image pinned** — specific version + digest; no `latest`.
- **Security scan clean** — no HIGH/CRITICAL CVEs.

## Capture lore

Base image choices, registry, and scan thresholds are high-value Dockerfile lore — call `suggest_lore` with `tags: [docker, containers, infra]`.
