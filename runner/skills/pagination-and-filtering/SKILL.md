---
name: pagination-and-filtering
description: Use when a ticket exposes a list — an API collection endpoint, a table in the UI, an export — with paging, sorting, filtering, or search, and the result must be stable under concurrent writes, bounded in cost, and consistent with the repo's existing list conventions. Invoke for "list the X", "add pagination", "let users filter by Y", "the list skips items", or "sorting is wrong on page 2".
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: backend
---

# Paginate, sort and filter a collection

A list endpoint is where unbounded cost and subtle inconsistency hide. Offset paging
skips or repeats rows when the table changes underneath it; an unindexed filter becomes
a table scan at scale; an unbounded page size is a denial-of-service. Follow the repo's
list contract, prefer cursors, bound everything, and make the sort total.

## Steps

1. **Match the existing list contract.** Find a sibling list endpoint or component and
   copy its envelope (`items`, `next_cursor`/`page`, `total` if offered), parameter
   names (`limit`, `cursor`, `sort`, `filter[...]`), and defaults. Call `search_lore` for
   the repo's pagination convention. Inconsistent list shapes are the most common API
   complaint.
2. **Prefer cursor (keyset) pagination** for anything that changes: encode the last
   row's sort key(s) in an opaque cursor, query `WHERE (sort_key, id) > (?, ?) ORDER BY
   sort_key, id LIMIT n+1`. Use offset only for small, static lists or when the UI
   genuinely needs "jump to page 7", and say so.
3. **Make the sort total and indexed.** Every sort must end with a unique tiebreaker
   (the primary key) or rows can appear on two pages. Every sortable and filterable
   column is backed by an index that matches the query's order (the
   `sql-query-performance` skill); allow-list the sortable fields, never accept an
   arbitrary column name.
4. **Bound the page.** A default `limit` (20–50), a hard maximum (100–200), and reject
   anything above it with a clear error. Fetch `limit + 1` to know whether a next page
   exists without a second count query.
5. **Design filters as data, not strings.** Typed filter parameters with validated
   operators (`status=in:open,ready`, `created_after=2026-01-01`), never a raw query
   fragment from the client. Full-text search goes through the search engine or the
   database's FTS, with its own limits.
6. **Decide on totals honestly.** `COUNT(*)` on a filtered large table is expensive;
   offer an exact total only when cheap, otherwise an estimate or `has_more`. Never
   silently compute an expensive count on every page.
7. **Keep the UI in step.** The table component uses the same parameter names, shows
   the active sort and filters in the URL (so a page is shareable and back works), and
   handles the empty, loading, and error states (the `frontend-data-fetching` skill).
8. **Test the edges**: first page, last page, an empty result, a row inserted between
   two page requests (no skip, no repeat), the maximum limit, an invalid sort field, a
   filter with no matches. Evidence with the `record-evidence` skill, including the
   query plan for the paged query.

## Rules

- Same envelope and parameter names as the repo's other lists.
- Cursor pagination by default; offset only with a stated reason.
- Every sort ends in a unique tiebreaker and is index-backed.
- Default and maximum limits enforced; `limit + 1` for `has_more`.
- Sortable and filterable fields are allow-listed and typed; no raw fragments.
- Totals only when cheap; otherwise `has_more` or an estimate, said plainly.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the list contract you learn the repo's envelope, cursor format and which columns are safe to sort on.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
