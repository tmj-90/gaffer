# Gaffer Mode-2 delivery image. The agent (`claude -p`) runs inside a container built
# from this: Linux + node + git + ripgrep + the Claude Code CLI. The factory's own dist
# bins, skills, safety hook, and node_modules are MOUNTED in at their host paths
# (path-mirrored) by lib/sandbox-docker.sh, so this image stays generic — it is the
# runtime, not a snapshot of the factory. Model credential is injected at run time
# (ANTHROPIC_API_KEY or a mounted ~/.claude credential), never baked in.
# BASE IMAGE PINNED BY DIGEST (the multi-arch index of the tag), so a tag moved or
# replaced upstream cannot change what is built. Dependabot (docker, .github/dependabot.yml)
# proposes a new digest; to bump by hand, read the index digest of the tag and replace
# it here, e.g. `docker buildx imagetools inspect node:22-bookworm-slim` (the Digest line).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*

# The Claude Code CLI (the worker), PINNED, the same version as the release image's: a release runs the CLI version its
# safety hook and MCP contract were tested with, never whatever is latest at tag time.
# To bump: `npm view @anthropic-ai/claude-code version`, run the runner suite against
# it, then change this default (or pass --build-arg CLAUDE_CODE_VERSION=x.y.z).
# Dependabot cannot see this pin (it is not in a package.json): bump it by hand.
ARG CLAUDE_CODE_VERSION=2.1.325
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

ENV GAFFER_SANDBOX=1
WORKDIR /work
CMD ["claude", "--version"]
