# Gaffer control plane + runner in one image: the dashboard/API (dispatch), the
# crew and memory CLIs and MCP servers, the bash runner, and the Claude Code CLI
# the runner spawns. State lives in the /data volume (GAFFER_DATA); repos to work
# on are bind-mounted under /repos. Started by compose.yaml, or directly:
#
#   docker build -t gaffer .
#   docker run --rm -p 127.0.0.1:8787:8787 -v gaffer-data:/data \
#     -e ANTHROPIC_API_KEY -v "$PWD/repos:/repos" gaffer
#
# Inside the container the container IS the containment boundary, so the runner's
# own OS sandbox is off (SANDBOX_PROVIDER=none); the red-team-gated docker provider
# is for running the factory on a host with a Docker daemon.
FROM node:22-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
# The root `prepare` script installs husky's git hooks; there is no .git in the
# build context, so skip it (HUSKY=0) rather than skipping ALL install scripts —
# better-sqlite3 needs its prebuilt-binary install step.
ENV HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* .npmrc* ./
COPY packages/dispatch/package.json packages/dispatch/
COPY packages/crew/package.json packages/crew/
COPY packages/memory/package.json packages/memory/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build

FROM node:22-bookworm-slim
# Release metadata (set by .github/workflows/release.yml; defaults for local builds).
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Gaffer" \
      org.opencontainers.image.description="The software factory: control plane, runner and memory in one image." \
      org.opencontainers.image.source="https://github.com/tmj-90/gaffer" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl bash \
  && rm -rf /var/lib/apt/lists/*
# The worker the runner spawns per ticket. Pin the version to the one your
# safety-hook / MCP contract was tested with when you deploy for real.
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data /repos && chown -R node:node /app /data /repos
USER node
ENV GAFFER_DATA=/data \
    SANDBOX_PROVIDER=none \
    DISPATCH_API_PORT=8787 \
    HOME=/home/node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -sf http://127.0.0.1:8787/healthz || exit 1
CMD ["bash", "runner/gaffer", "dashboard", "--foreground", "--lan"]
