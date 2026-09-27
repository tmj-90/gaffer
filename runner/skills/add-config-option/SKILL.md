---
name: add-config-option
description: Use when a ticket adds or changes a configuration option — an environment variable, a settings key, a CLI flag, a YAML field — that operators set, and it must have one source of truth, a validated default, precedence rules, and documentation that cannot drift. Invoke for "make X configurable", "add an env var for Y", "expose a setting", or "the default should be Z".
stack: []
area: workflow
---

# Add a configuration option

Configuration is the operator's API. A new option must be discoverable, validated,
defaulted safely, and documented from the same place it is defined, so the docs and the
code cannot disagree. Half the incidents that start with "we set the env var" end with
"in the wrong process".

## Steps

1. **Find the repo's config spine.** Where options are declared (a schema, a settings
   table, a `config.sh`, a typed `Config` object), how precedence works (real env >
   config file > mode preset > default is a common shape), and how docs are generated
   from it. Call `search_lore` for the convention. Add your option THERE; never read
   `process.env.X` from a random module.
2. **Name it by the repo's rules.** Prefix, casing, and unit suffixes
   (`GAFFER_TICK_TIMEOUT_MS`, not `timeout`). A name that encodes its unit and scope
   prevents the classic seconds-vs-milliseconds outage.
3. **Type and validate at load time.** Parse once into a typed value (integer range,
   enum, URL, path that exists), fail fast with a message naming the option and the
   bad value. A silently-ignored malformed setting is worse than a crash.
4. **Choose the default deliberately.** The default is what every operator who does
   not know the option exists will run. It must be safe and match today's behaviour
   unless the ticket says otherwise; say why in a comment.
5. **Thread it to every process that needs it.** If a child process, a spawned agent, or
   a dashboard also needs the value, it must be exported or passed explicitly, and the
   precedence must be the same there. Test that the value actually reaches the consumer,
   not just that it parses.
6. **Document from the source.** Regenerate the reference doc if the repo generates one
   (a `docs/CONFIG.md` from the declarations); otherwise add the option to the config
   table with its default, unit, and effect. If the dashboard exposes settings, add it
   there through the existing settings definition, not a parallel form.
7. **Test it**: default applied when unset, override honoured, invalid value rejected
   with the right message, and (if relevant) that a child process sees it. Evidence with
   the `record-evidence` skill.

## Rules

- One declaration point; no ad-hoc env reads scattered through modules.
- Name with prefix, scope, and unit; validate and fail fast.
- Safe default that preserves current behaviour unless the ticket changes it.
- Same precedence in every process that reads it; prove the value arrives.
- Docs generated or updated from the declaration in the same change.
- A secret is not a config option: use the `security-secret-handling` skill.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While threading the option to every process you learn the repo's real config precedence and which processes read which values.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
