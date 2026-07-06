---
name: Worker / delivery run failure
about: A ticket delivery, agent run, or factory loop failed or misbehaved
title: "[run] "
labels: run-failure
---

**What you ran**
The command (e.g. `runner/loop.sh`, `runner/gaffer run`, a dashboard action) and the mode
(supervised / graduated / autonomous / strict; `SANDBOX_PROVIDER` if set).

**What happened vs expected**
What the runner/agent did, and what you expected instead.

**Evidence (redact secrets first)**
- Relevant lines from the run log / `$GAFFER_DATA/*.log`
- The ticket's evidence / rejection notes if it parked or bounced
- Whether a `gaffer/*` branch or worktree was left behind

**Environment**
- OS + `node --version` + `claude --version`
- Repo stack (language/framework) the ticket targeted
- Gaffer commit / release tag

**Anything else**
Was this a one-off or reproducible? Smallest ticket that reproduces it?
