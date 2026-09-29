---
name: python-conventions
description: Use when a ticket adds or changes Python code and it must follow the repo's Python conventions — PEP 8, full type hints (PEP 484) checked by mypy/pyright, dataclasses, pythonic idioms, explicit error handling, asyncio and thread safety, ruff-clean, and pytest with coverage via the repo's env manager (uv/poetry). Invoke for "add this in Python", "fix the type/lint errors", "add the FastAPI/Django endpoint", or as the language pack for any Python change or Python review.
stack: [python]
area: language
---

# Write idiomatic, typed Python

Python stays maintainable when every signature is typed, errors are narrow, resources
live in `with` blocks and shared state is guarded. For the builder and the reviewer of a Python diff; the repo's config and existing code win over it.

## Procedure

1. **Discover the repo's conventions first.** Call `search_lore` for Python conventions.
   Read `pyproject.toml` (`requires-python`, `[tool.ruff]`, `[tool.mypy]`/`[tool.pyright]`,
   `[tool.pytest.ini_options]`), the lockfile that names the env manager (`uv.lock` → uv,
   `poetry.lock` → Poetry, `requirements*.txt` → pip/venv), `tox.ini`/`noxfile.py`,
   `.pre-commit-config.yaml` and the CI workflow. Open the nearest sibling module and its
   test; copy its imports, data modelling (dataclass/Pydantic/attrs), logging and fixtures.
   Never install into the system interpreter; never edit tool config to make your change pass.
2. **Pin the exact commands** from CI, `Makefile`, tox/nox or pre-commit (the `run-tests`
   and `run-lint` skills). Use the defaults below only when the repo defines none.
3. **Write the change with the idioms below**, then walk the concurrency section for
   every task, thread, file, connection and shared object you touched.
4. **Test each acceptance criterion's own behaviour.** One pytest test (or `parametrize`
   case) per AC that fails without your change, plus its error path. If the AC involves
   shared state or persistence, add a test that runs N concurrent callers
   (`ThreadPoolExecutor` or `asyncio.gather`) and asserts the invariant.
5. **Verify, then stop.** Done when: lint and format check are clean, the type checker
   reports no new errors, the test suite (with the repo's coverage gate) is green, and
   every AC has a test. Record the output with the `record-evidence` skill; the runner
   submits the work.

## Commands

- Env: use the existing environment — `uv run --no-sync …` (plain `uv run` syncs, i.e.
  installs), `poetry run …`, or `.venv/bin/…`. Never install: the hook blocks
  `pip install`, and `uv sync`/`poetry install`/`uv add` are forbidden too though the hook
  does not catch them. A missing tool goes in the evidence.
- Lint and format: `ruff check .` and `ruff format --check .` (or `black --check .` and
  `isort --check` where the repo still uses them).
- Types: `mypy .` (or the configured paths/`--strict`) or `pyright`, per the repo.
- Tests: `pytest -q`; one test: `pytest path/test_x.py::test_name`; coverage:
  `pytest --cov=<pkg> --cov-report=term-missing`.
- Security when relevant: `pip-audit` (if installed; it reads the environment, never
  fixes it); `bandit -r <pkg>` if configured.

## Idioms that matter

- **Types everywhere** (PEP 484): annotate every signature and public attribute; precise
  types (`Sequence`, `Mapping`, `Protocol`, `TypedDict`, `Literal`, `Self`) over `Any`;
  fix the cause rather than adding `# type: ignore` (if unavoidable, use a code:
  `# type: ignore[arg-type]` plus a reason).
- **Model data** with `@dataclass(frozen=True, slots=True)` or the repo's Pydantic models
  at boundaries, not dicts of string keys. Validate external input (request bodies, env,
  files) once, at the boundary.
- **Errors**: catch the narrowest exception; no bare `except:` (it catches
  `KeyboardInterrupt`/`SystemExit`); `raise DomainError(...) from err` to keep the cause;
  log with `logger.exception` only where you handle it.
- **Pythonic**: `pathlib`, `zip(strict=True)`, `is None`; module-level
  `logger = logging.getLogger(__name__)`.
- **Time**: timezone-aware datetimes (`datetime.now(timezone.utc)`); `datetime.utcnow()`
  is deprecated (3.12) and returns a naive value.

## Concurrency and resource safety

- **Resources in `with`** (files, locks, sockets, DB sessions, `tempfile`); `open()` gets
  an explicit `encoding="utf-8"` for text.
- **The GIL is not a lock.** `counter += 1`, check-then-set on a dict, and read-modify-write
  of a file are races between threads, and free-threaded CPython 3.13+/3.14 removes even
  incidental protection. Guard shared state with `threading.Lock`, hold it across the
  whole read-modify-write, and prefer `queue.Queue` for handoff.
- **Files other requests read**: never overwrite in place or through a fixed temp name.
  Write with `tempfile.NamedTemporaryFile(dir=target.parent, delete=False)` (unique, same
  filesystem), `flush` + `os.fsync`, then `os.replace(tmp, target)`. Cross-process
  exclusion needs an OS lock (`fcntl.flock`) or the database; a time-only lease lets a
  paused holder write after another took over, so the write must verify a fencing token
  or version.
- **asyncio**: never call blocking code (`time.sleep`, `requests`, sync DB drivers, heavy
  CPU) inside `async def`; use the async client or `await asyncio.to_thread(...)`. Keep a
  reference to every `asyncio.create_task(...)` (the loop holds only weak references) or
  use `asyncio.TaskGroup` (3.11+); bound fan-out with `asyncio.Semaphore`; put deadlines on waits
  with `asyncio.timeout(...)`. Do not swallow `asyncio.CancelledError`: clean up and re-raise.
- **Shared async state** still races across `await`: a read, an `await`, then a write can
  interleave with another task. Use `asyncio.Lock` or do it in one transaction.
- **Mutable defaults** (`def f(x=[])`) and late-binding lambdas in loops share state across
  calls; use `None` and bind loop values explicitly.
- **Untrusted data** never reaches `eval`, `pickle.loads`, `yaml.load` (use
  `yaml.safe_load`), `subprocess(..., shell=True)` or an f-string SQL query.

## Review checklist — flag as defects

Walk this against the diff. An item is grounds for CHANGES only when, in changed code, it
causes a concrete failure (wrong result, crash, lost or corrupted data, security hole) or
leaves an AC's own behaviour untested: cite the line and that failure. Otherwise it is an
`(optional)` note. Formatting the tools would fix, and preferences the repo
does not enforce, are not findings. Do not patch the code under review.

- [ ] A bare `except:`, or `except Exception` that passes, logs-and-continues where the
      caller needed the failure, or loses the cause (no `from err`).
- [ ] A signature is untyped or uses unexplained `Any`; a new `# type: ignore` or ruff
      `noqa` without a code and reason; tool config loosened.
- [ ] A mutable default argument, or a closure capturing a loop variable by reference.
- [ ] Shared state mutated from threads or tasks without a lock, or a read-modify-write
      that spans an `await` or releases the lock midway.
- [ ] A blocking call inside `async def`; a created task not referenced or awaited;
      `CancelledError` swallowed; an unbounded `gather` over user-sized input.
- [ ] A file, connection or lock acquired outside `with` and not released on the error path.
- [ ] A shared file written in place or via a fixed temp name; a lock with a time-only lease
      and no fencing check.
- [ ] External input used without validation; untrusted data reaches `eval`, `pickle`,
      `yaml.load`, `shell=True` or string-built SQL.
- [ ] Naive datetimes compared with aware ones, or `utcnow()` in new code.
- [ ] An AC has no test, the test mocks away the code the AC is about, or a concurrency AC
      has no concurrent test.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A Python convention this repo enforces beyond the obvious — a version constraint, a typing/validation pattern, an env-manager quirk, or a lint/type-checker rule.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
