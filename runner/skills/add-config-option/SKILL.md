---
name: add-config-option
description: Use when a ticket adds or changes a configuration option — an environment variable, a settings key, a CLI flag, a YAML field — that operators set, and it must have one source of truth, a validated default, precedence rules, and documentation that cannot drift. Invoke for "make X configurable", "add an env var for Y", "expose a setting", or "the default should be Z".
stack: []
area: workflow
---

# Add a configuration option

Configuration is the operator's API: everything that varies between deploys while the
code stays the same. A new option must be declared once, parsed and validated at
startup, defaulted to today's behaviour, and documented from the same place it is
defined. Half the incidents that start with "we set the env var" end with "in the wrong
process" or "in seconds, not milliseconds".

## Steps

1. **Confirm it should be an option at all.** Twelve-factor's test: config is what varies
   per deploy (hosts, credentials, limits, feature switches). A value that never differs
   between environments is a constant — keep it in code (the `minimalism` skill). A
   credential is not an ordinary option: follow the `security-secret-handling` skill.
2. **Find the config spine.** Where options are declared (a schema, a settings module, a
   `config.sh`, a typed `Config` object), how precedence works (commonly: CLI flag, then
   env var, then config file, then default), and whether docs are generated from it. Call `search_lore`
   for the convention, and search for existing env reads with the Grep tool (a Bash
   command mentioning `process.env` is hook-blocked). Add the option THERE; never read
   `process.env.X` or `os.environ` from a random module.
3. **Name it by the repo's rules.** Prefix, casing, scope and unit
   (`APP_UPLOAD_TIMEOUT_MS`, not `timeout`). The unit in the name prevents the classic
   seconds-vs-milliseconds outage. Never reuse a retired option's name for new meaning.
4. **Parse once, validate at load, fail fast.** Convert to a typed value (integer with a
   range, enum, URL, duration, path) at startup and exit with a message naming the option
   and the bad value. Treat an empty string explicitly (unset or invalid — decide and
   test). Booleans accept a documented set (`true/false/1/0`), not "anything non-empty".
   A silently ignored malformed setting is worse than a crash.
5. **Choose the default deliberately.** It is what every operator who does not know the
   option exists will run: it must be safe and preserve current behaviour unless the
   ticket says otherwise. State why in one comment at the declaration.
6. **Thread it to every consumer.** If a child process, worker, container or dashboard
   needs the value, pass it explicitly (spawn env, compose file, chart values) with the
   same precedence. Prove the value arrives at the consumer, not just that it parses.
7. **Document from the source.** Regenerate the reference doc if the repo generates one;
   otherwise add a row to the config table in README/docs: name, type, default, unit,
   effect, since-version. If the dashboard or an admin UI lists settings, add it through
   that existing settings definition, not a parallel form. The safety hook blocks every
   `.env*` file, including
   `.env.example`: if the repo keeps one, say in your evidence that it needs the new key
   added by a human.
8. **Test it:** default applied when unset; override honoured; each invalid form rejected
   with the named message; precedence (flag beats env) when the repo has layers; the child
   process sees it when step 6 applies. Evidence via the `record-evidence` skill (on a
   resume that call is refused: do not retry; put this, the AC → test map and the
   smallest-change note in your final message).

## Done when

One declaration exists; the default equals today's behaviour (or the ticket's stated
value); invalid values fail at startup with a clear message; tests cover default,
override and invalid; docs name the option, type, default and unit.

## Stop and escalate when

- The right default is a product or operational judgement the ticket does not settle:
  `request_decision` with the options and their effect.
- The repo has two competing config systems: use the one the surrounding code uses and
  `request_decision` rather than adding a third.

## Rules

- One declaration point; no scattered ad-hoc environment reads.
- Name with prefix, scope and unit; validate and fail fast.
- Safe default that preserves current behaviour unless the ticket changes it.
- Same precedence in every process; prove the value arrives.
- Never log a config value that might be a secret; log the option name.
- Work on the delivery branch (the `create-branch` skill verifies); commit, never push.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While threading the option to every process you learn the repo's real config precedence and which processes read which values.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
