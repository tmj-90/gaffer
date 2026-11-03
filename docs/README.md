# Gaffer docs

Every doc in the repository, by what you need. The [README](../README.md) is the
overview; start there if you're new.

## Install and first run

- [quickstart.md](../quickstart.md): from a clean checkout to one ticket merged, plus a
  greenfield build and the container.
- [runner/ONBOARDING.md](../runner/ONBOARDING.md): what `gaffer onboard` does, and
  what to do when it goes wrong.
- [runner/RUNBOOK.md](../runner/RUNBOOK.md): driving each component by hand (manual
  init, registering the MCP servers with your agent CLI).

## Concepts

- [ARCHITECTURE.md](../ARCHITECTURE.md): the four components, a ticket's lifecycle,
  the stores and the extension points.
- [FEATURES.md](FEATURES.md): every surface (planning, the board, review, landing,
  the Factory Map, memory, the tester, settings, skills).
- [runner/README.md](../runner/README.md): the runner in depth: ticks, delivery,
  landing, model routing, the digest lifecycle.
- [packages/dispatch/README.md](../packages/dispatch/README.md),
  [packages/crew/README.md](../packages/crew/README.md),
  [packages/memory/README.md](../packages/memory/README.md): each package on its own,
  with memory's [principles](../packages/memory/docs/PRINCIPLES.md),
  [data flow](../packages/memory/docs/DATA-FLOW.md) and
  [ADR-003](../packages/memory/docs/adr/ADR-003-conflict-records-shape.md).

## Configure

- [CONFIG.md](CONFIG.md): every setting, its default, whether the dashboard can edit
  it and which component reads it (generated from the code).
- [sandbox.md](sandbox.md): the OS sandbox providers, `docker` in detail, and how to
  prove a live delivery on your fork.
- [worker-providers.md](worker-providers.md): running your own worker program.
- [skill-selection-and-stacks.md](skill-selection-and-stacks.md): which skills each
  agent gets, and how a repo's stack is detected.
- [eval-harness.md](eval-harness.md): the opt-in judge, the eval ledger and gate
  replay.
- [openapi.json](openapi.json): the REST contract (generated).

## Security

- [SECURITY.md](../SECURITY.md): the threat model, what each control enforces and how
  it is tested, the residual limits, and how to report a vulnerability.

## Run and test

- [testing.md](testing.md): the test layers, the runner harness, what CI runs.
- [scripts/ui-regression/README.md](../scripts/ui-regression/README.md): the browser
  regression and scenario suites.
- [runner/eval/README.md](../runner/eval/README.md): the gate replay fixtures.

## Contribute

- [CONTRIBUTING.md](../CONTRIBUTING.md): setup, ground rules, commit and PR style.
- [runner/CLAUDE.md](../runner/CLAUDE.md): the rule that delivery features land on
  the live path.
- [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md).

## Release

- [RELEASING.md](RELEASING.md): the checks before a release, cutting one, and
  verifying its artifacts.
- [CHANGELOG.md](../CHANGELOG.md).
- [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
