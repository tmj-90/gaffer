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
# own OS sandbox is off (SANDBOX_PROVIDER=none) and the image opts out of the sandbox
# every agent launch otherwise requires (GAFFER_STRICT_REQUIRE=0, the documented
# environment opt-out); the red-team-gated docker provider is for running the factory
# on a host with a Docker daemon.
# BASE IMAGE PINNED BY DIGEST (the multi-arch index of the tag), so a tag moved or
# replaced upstream cannot change what is built. Dependabot (docker, .github/dependabot.yml)
# proposes a new digest; to bump by hand, read the index digest of the tag and replace
# it here, e.g. `docker buildx imagetools inspect node:22-bookworm-slim` (the Digest line).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
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

# Same pinned base as the build stage (bump both together).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
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
# The worker the runner spawns per ticket, PINNED: a release runs the CLI version its
# safety hook and MCP contract were tested with, never whatever is latest at tag time.
# To bump: `npm view @anthropic-ai/claude-code version`, run the runner suite against
# it, then change this default (or pass --build-arg CLAUDE_CODE_VERSION=x.y.z).
# Dependabot cannot see this pin (it is not in a package.json): bump it by hand.
ARG CLAUDE_CODE_VERSION=2.1.325
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data /repos && chown -R node:node /app /data /repos
USER node
# GAFFER_BOOTSTRAP_ROOT: a greenfield repo the factory creates lives on the /repos
# mount, so recreating the container keeps it (its registration lives in /data).
# GAFFER_STRICT_REQUIRE=0 beside SANDBOX_PROVIDER=none: the container is the
# containment, so agents here run without an OS sandbox of their own (said once at start).
ENV GAFFER_DATA=/data \
    GAFFER_BOOTSTRAP_ROOT=/repos \
    SANDBOX_PROVIDER=none \
    GAFFER_STRICT_REQUIRE=0 \
    DISPATCH_API_PORT=8787 \
    HOME=/home/node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -sf http://127.0.0.1:8787/healthz || exit 1
CMD ["bash", "runner/gaffer", "dashboard", "--foreground", "--lan"]
