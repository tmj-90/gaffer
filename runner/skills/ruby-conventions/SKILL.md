---
name: ruby-conventions
description: Use when a ticket adds or changes Ruby code — Rails apps, gems, Rake tasks — and it must follow the repo's Ruby conventions — the Ruby Style Guide, small objects with clear responsibilities, Rails idioms where Rails is present (migrations, validations, scopes, jobs), thread-safe code under Puma and Sidekiq, no metaprogramming for its own sake, RuboCop/Standard clean — as the language pack for any Ruby change. Invoke for "add this in Rails", "fix the N+1", "the RuboCop offences", or when reviewing a Ruby diff.
stack: [ruby, rails]
area: language
---

# Write idiomatic Ruby (and Rails)

Ruby's expressiveness helps readers when objects are small, named well and follow the
idioms the repo already uses; it hurts when metaprogramming hides behaviour or Rails
conventions are fought. For the builder and the reviewer of a Ruby diff; the repo's config and existing code win over it.

## Procedure

1. **Discover the repo's conventions first.** Call `search_lore` for Ruby conventions.
   Read `.ruby-version`/`.tool-versions`, `Gemfile` and `Gemfile.lock`, `.rubocop.yml`
   (and `inherit_from`/`inherit_gem`: Standard, `rubocop-rails-omakase`, a
   `.rubocop_todo.yml`), `.standard.yml`, type tooling (`sorbet/`, `sig/` for RBS), `.rspec`
   or `test/`, `config/application.rb` (`load_defaults`), the job adapter and the CI
   workflow. Identify the service/query/form object patterns and factories. Copy a sibling
   class and its spec.
2. **Pin the exact commands** from CI or `bin/` scripts (the `run-tests` and `run-lint`
   skills). Use the defaults below only when the repo defines none. Never add offences to
   `.rubocop_todo.yml` to pass.
3. **Write the change with the idioms below**, then walk the concurrency section for every
   shared object, record update, job, file and outbound call you touched.
4. **Test each acceptance criterion's own behaviour.** One request/model/job spec (or
   Minitest test) per AC that fails without your change, plus its error path. If the AC
   involves shared state or persistence, add a test that runs N threads against it (each
   with its own connection via `ActiveRecord::Base.connection_pool.with_connection`, and
   transactional fixtures disabled for that test) and asserts the invariant.
5. **Verify, then stop.** Done when: RuboCop/Standard is clean, the suite is green, a new
   migration migrates and rolls back, and every AC has a test. Record the output with the
   `record-evidence` skill; the runner submits the work.

## Commands

- Gems are already installed; never run `bundle install`/`bundle update`/`bundle add`
  (installs need human approval; the hook does not catch these, the rule still holds). A
  missing gem goes in the evidence.
- Lint: `bundle exec rubocop` (or `bin/rubocop`, `bundle exec standardrb`).
- Tests: `bundle exec rspec` (one: `bundle exec rspec spec/x_spec.rb:42`) or `bin/rails
  test` (one: `bin/rails test test/x_test.rb:42`).
- Migrations: `bin/rails db:migrate` then `bin/rails db:rollback` and migrate again,
  only against the local development/test database; with none reachable, say so in the
  evidence.
- Security and types where configured: `bundle exec brakeman`, `bundle exec bundle-audit
  check`, `bundle exec srb tc` or `bundle exec steep check`.

## Idioms that matter

- **Small objects**: single-purpose classes and short methods; service objects for
  multi-step operations, query objects for complex reads, form objects for non-model
  input; no fat models or controllers, no concern that exists only to split a huge class.
- **Idiomatic Ruby** (Ruby Style Guide): `each`/`map`/`select` over `for`; guard clauses;
  keyword arguments for more than two parameters; `Data.define`/`Struct` for simple values;
  the `# frozen_string_literal: true` magic comment where the repo uses it; no
  monkey-patching core classes; no `method_missing`/`define_method` without precedent.
- **Rails the Rails way**: validations in the model and constraints in the database
  (`null: false`, unique indexes, foreign keys — the `add-db-migration` skill); scopes for
  reusable queries; strong parameters; `includes`/`preload` to kill N+1; `ActiveJob` for
  async work (the `background-jobs` skill); I18n for user-visible strings (the `i18n-l10n`
  skill).
- **Errors**: custom error classes under the app namespace; `rescue` specific classes;
  never `rescue Exception` (catches signals and exit) or `rescue nil`; re-raise with
  context; result objects for expected failures where the repo uses them.
- **Security by convention**: parameterised queries (`where(id: v)`, `where("x = ?", v)`),
  never interpolation; `html_safe`/`raw` only on sanitised content; `YAML.safe_load`, not
  `YAML.load`/`Marshal.load` on untrusted data; no `send`/`constantize` on user input.

## Concurrency and resource safety

- **Puma and Sidekiq run your code on many threads.** Class-level instance variables,
  `@@class_variables`, constants holding mutable objects and class-level `||=`
  memoisation are shared across requests and race. Use request-scoped objects,
  `ActiveSupport::CurrentAttributes`, or a `Mutex` held across the whole
  read-modify-write.
- **Lost updates on records**: read, change in Ruby, `save` loses concurrent writes. Use
  `record.with_lock { … }`, optimistic locking (`lock_version`, rescue
  `ActiveRecord::StaleObjectError`), or atomic SQL (`increment!`, `Model.update_counters`).
- **Check-then-create races**: `find_or_create_by` can insert duplicates; back it with a
  unique index and rescue `ActiveRecord::RecordNotUnique` (or `create_or_find_by`).
- **Jobs and transactions**: enqueue jobs and send mail in `after_commit` (or after the
  transaction), never inside it — the job can run before the row is visible or after a
  rollback. Jobs are retried: make them idempotent.
- **Files other requests read**: `File.write` is not atomic. Write to
  `Tempfile.create(["name", ".tmp"], File.dirname(target))` (unique, same filesystem), then
  `File.rename(tmp.path, target)`. Always use the block form of `File.open`. Cross-process
  exclusion uses `File#flock` or the database; a time-only lease lets a paused holder write
  late, so writes must check a version.
- **Timeouts**: set open/read timeouts on `Net::HTTP` and client gems; do not use
  `Timeout.timeout` around code that holds resources.

## Review checklist — flag as defects

Walk this against the diff. An item is grounds for CHANGES only when, in changed code, it
causes a concrete failure (wrong result, crash, lost or corrupted data, security hole) or
leaves an AC's own behaviour untested: cite the line and that failure. Otherwise it is an
`(optional)` note. Formatting the tools would fix, and preferences the repo
does not enforce, are not findings. Do not patch the code under review.

- [ ] Bare `rescue`, `rescue Exception`, `rescue nil`, or a rescue that logs and continues
      where the caller needed the failure.
- [ ] Mutable class-level state or class-level memoisation shared across threads.
- [ ] A read-modify-write on a record without a lock, `lock_version` or atomic SQL; a
      `find_or_create_by` without a unique index.
- [ ] A job enqueued or mail sent inside a transaction; a non-idempotent retried job.
- [ ] An N+1 query in a loop or view the diff introduced.
- [ ] String-interpolated SQL; `html_safe`/`raw` on user content; `YAML.load`/`Marshal.load`
      /`constantize`/`send` on untrusted input; unpermitted params.
- [ ] A migration that is irreversible without `down`, changes data in a schema
      migration, or omits the constraint or index the model relies on.
- [ ] A shared file written in place or via a fixed temp name; `File.open` without a block;
      a time-only lock lease; an outbound call without timeouts.
- [ ] A new RuboCop disable or todo entry without a reason.
- [ ] An AC has no spec, or the spec stubs the behaviour the AC describes.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the repo you learn the service, query and form object patterns, the job adapter and the RuboCop exceptions.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
