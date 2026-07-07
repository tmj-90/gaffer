# Gaffer Mode-2 delivery image. The agent (`claude -p`) runs inside a container built
# from this: Linux + node + git + ripgrep + the Claude Code CLI. The factory's own dist
# bins, skills, safety hook, and node_modules are MOUNTED in at their host paths
# (path-mirrored) by lib/sandbox-docker.sh, so this image stays generic — it is the
# runtime, not a snapshot of the factory. Model credential is injected at run time
# (ANTHROPIC_API_KEY or a mounted ~/.claude credential), never baked in.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*

# The Claude Code CLI (the worker). Pin-free for the P0 spike; a real deployment pins
# the version to match the host's safety-hook/MCP contract.
RUN npm install -g @anthropic-ai/claude-code

ENV GAFFER_SANDBOX=1
WORKDIR /work
CMD ["claude", "--version"]
