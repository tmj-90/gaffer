---
name: python-conventions
description: Use when a ticket adds or changes Python code and it must follow the repo's Python conventions — PEP 8, full type hints, dataclasses, pythonic idioms, explicit error handling, and pytest with coverage. Invoke for "add this in Python", "fix the type/lint errors", "add the FastAPI/Django endpoint", or as the language pack for any Python change.
stack: [python]
area: language
---

# Write idiomatic, typed Python

Add Python that reads as pythonic, is fully type-hinted, and matches the repo's
existing idioms and tooling — clear and correct, not just runnable.

## Steps

1. **Read the lore first.** Call `search_lore` (Memory MCP) for the repo's Python
   conventions and respect its config: the Python version, `pyproject.toml`
   (dependencies, tool config), the formatter/linter (ruff / black), and the type
   checker (mypy / pyright). Use the project's environment manager (poetry / venv /
   uv) — never install globally.
2. **Find a sibling module** and copy its patterns — package layout, import style,
   error handling, how data is modelled, and how tests are organised.
3. **Type everything.** Add type hints on every function signature and public
   attribute; prefer precise types (`Sequence`, `Mapping`, `Protocol`, `TypedDict`,
   `Literal`) over bare `Any`. Justify any `Any` in a comment. Run the project's type
   checker and fix the cause of errors rather than `# type: ignore`-ing them.
4. **Model data with `@dataclass`** (frozen where it should be immutable) or Pydantic
   when the repo already uses it for validation at boundaries — not loose dicts of
   stringly-typed keys.
5. **Be pythonic.** Comprehensions and generators over manual loops where readable;
   context managers (`with`) for resources; `pathlib` over string paths; f-strings for
   formatting; `enumerate`/`zip` over index juggling.
6. **Handle errors explicitly.** Catch the **narrowest** exception that fits — **no bare
   `except:`** and no blanket `except Exception` that swallows. Re-raise with context
   (`raise X from err`) or handle; never silently pass. Validate external input at the
   boundary.
7. **Test with pytest.** Use fixtures and `parametrize` for table-style cases; cover
   happy path, edge cases, and error conditions; assert behaviour, not incidental detail.
8. **Verify + evidence.** Run the project's tests + lint + type check, record
   `test_output` via the `record-evidence` skill, and submit for review.

## Build / Test

- **Tests:** `pytest` (or `poetry run pytest`); coverage via `pytest --cov`.
- **Lint/format:** `ruff check .` and `black --check .` (or the repo's configured
  equivalents); fix, don't suppress.
- **Types:** `mypy .` / `pyright` per the repo config.
- The DoD is verified by the repo's configured test/coverage commands — run them and
  record the output; a green run with coverage is the evidence.

## Review checklist (a Python reviewer must check)

- **Type hints present and precise** on all signatures; no unexplained `Any`; type
  checker passes (no stray `# type: ignore`).
- **No bare `except:`** and no swallowing `except Exception: pass`; exceptions are
  narrowed and re-raised with context or handled deliberately.
- **PEP 8 / formatter clean** — ruff + black report no diff.
- **Data modelled with dataclasses/Pydantic**, not ad-hoc dicts; frozen where immutable.
- **Resources use context managers**; no leaked file handles / connections.
- **Mutable default arguments** avoided (`def f(x: list | None = None)`, not `= []`).
- **Boundary input validated** before use (request bodies, env, file content).
- **Tests** use pytest fixtures/`parametrize` and cover error paths, not only the happy path.

## Rules

- Match the repo's Python version, env manager, linter/formatter, and type checker exactly.
- Type hints everywhere; `unknown`-equivalent precision over `Any`; validate external input.
- No bare excepts, no swallowed exceptions — narrow and handle or re-raise with context.
- Pythonic idioms (comprehensions, context managers, pathlib) where they improve clarity.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A Python convention this repo enforces beyond the obvious — a version constraint, a typing/validation pattern, an env-manager quirk, or a lint/type-checker rule.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
