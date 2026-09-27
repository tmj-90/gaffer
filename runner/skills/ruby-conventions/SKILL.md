---
name: ruby-conventions
description: Use when a ticket adds or changes Ruby code — Rails apps, gems, Rake tasks — and it must follow the repo's Ruby conventions — small objects with clear responsibilities, Rails idioms where Rails is present (migrations, validations, scopes, jobs), no metaprogramming for its own sake, RuboCop clean — as the language pack for any Ruby change. Invoke for "add this in Rails", "fix the N+1", "the RuboCop offences", or when reviewing a Ruby diff.
stack: [ruby, rails]
area: language
---

# Write idiomatic Ruby (and Rails)

Ruby's expressiveness is a gift to readers when code is small, named well, and follows
the community idioms the repo already uses. It is a trap when metaprogramming hides
behaviour or when Rails conventions are fought instead of followed. Match the repo's
style, lean on Rails where it exists, and keep RuboCop clean.

## Steps

1. **Read the repo's conventions.** Ruby and Rails versions, the RuboCop config, the
   test framework (RSpec or Minitest) and factories, the service/query/form object
   patterns in use, the background job adapter. Call `search_lore`; copy a sibling's
   shape.
2. **Small, named objects.** Single-purpose classes and methods (a few lines each);
   service objects for multi-step business operations, query objects for complex reads,
   form objects for non-model input; avoid fat models and fat controllers alike; prefer
   composition over deep inheritance and concerns that only exist to split a huge
   class.
3. **Idiomatic Ruby.** `each`/`map`/`select` over `for`; guard clauses over nested
   `if`; keyword arguments for methods with more than two parameters; frozen string
   literals; `Struct`/`Data` for simple values; no monkey-patching core classes; no
   `method_missing`/`define_method` unless the repo already relies on that pattern and
   it is documented.
4. **Rails the Rails way** when present: validations in models, constraints in the
   database too (the `add-db-migration` skill: reversible migrations, `null: false`,
   indexes, no data changes in schema migrations); scopes for reusable queries; strong
   parameters; `includes`/`preload` to kill N+1 (assert with `bullet` or a query-count
   test); `ActiveJob` for async work (the `background-jobs` skill); I18n for every
   user-visible string (the `i18n-l10n` skill).
5. **Errors explicitly.** Custom error classes under the app's namespace; `rescue`
   specific classes, never bare `rescue`; `raise` with messages; no `rescue nil`;
   return values or result objects for expected failures where the repo uses them.
6. **Security by convention.** No string interpolation into SQL (`where("x = ?", v)` or
   hashes); `html_safe` only on sanitised content; CSRF protection on; mass assignment
   through permitted params only.
7. **Test with the repo's framework**: request specs for endpoints, model specs for
   validations and scopes, system specs only for critical flows; factories from
   FactoryBot (the `test-fixtures-and-factories` skill); `bundle exec rubocop`, `bundle
   exec rspec` (or `rails test`). Evidence with the `record-evidence` skill.

## Review checklist (a Ruby reviewer must check)

- Objects small and single-purpose; no fat models/controllers, no gratuitous concerns.
- No bare `rescue`, no `rescue nil`; specific errors raised and handled.
- N+1 eliminated with `includes`/`preload` and pinned by a test.
- No SQL string interpolation; `html_safe` only on sanitised content; strong params.
- Migrations reversible with database constraints and indexes.
- RuboCop clean at the repo's configuration; every string internationalised.

## Rules

- Small objects, idiomatic Ruby, no metaprogramming without precedent and docs.
- Rails conventions followed, not fought; constraints in both model and database.
- Specific `rescue`s; expected failures as values where the repo does so.
- SQL parameterised; output escaped; params permitted.
- RuboCop and the test suite as CI runs them.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the repo you learn the service, query and form object patterns, the job adapter and the RuboCop exceptions.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
