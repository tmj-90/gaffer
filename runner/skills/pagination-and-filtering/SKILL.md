---
name: pagination-and-filtering
description: Use when a ticket exposes a list — an API collection endpoint, a table in the UI, an export — with paging, sorting, filtering, or search, and the result must be stable under concurrent writes, bounded in cost, and consistent with the repo's existing list conventions. Invoke for "list the X", "add pagination", "let users filter by Y", "the list skips items", or "sorting is wrong on page 2".
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: backend
---

# Paginate, sort and filter a collection

A list endpoint is where unbounded cost and subtle inconsistency hide. `OFFSET` makes
the database read and discard every skipped row, and it skips or repeats rows when the
table changes between requests; a non-unique sort order makes page boundaries
nondeterministic; an unbounded limit is a denial of service. Sources: Markus Winand,
_Use The Index, Luke_ ("Paging Through Results", "No Offset"); PostgreSQL and MySQL
documentation on row-value comparison and `ORDER BY`; RFC 8288 (`Link` header).

## Steps

1. **Match the existing list contract.** Copy a sibling endpoint/component: envelope
   (`items`, `next_cursor` or `page`, `total` if offered), parameter names (`limit`,
   `cursor`, `sort`, `filter[...]`), defaults, and error shape. Call `search_lore` for
   the repo's pagination convention. A second list shape is a defect.
2. **Prefer cursor (keyset) pagination** for data that changes. The cursor encodes the
   last row's sort-key values plus its id; the next page is
   `WHERE (created_at, id) < (:c_created_at, :c_id) ORDER BY created_at DESC, id DESC
   LIMIT :limit + 1`. With mixed directions (`name ASC, id DESC`) a row-value comparison
   is wrong; expand it: `name > :n OR (name = :n AND id < :id)`. Use offset only for
   small, static lists or a genuine "jump to page N" need, stated in the code.
3. **Make the sort total, index-backed and NULL-safe.** Every sort ends with a unique
   tiebreaker (the primary key). Back each allowed sort with a composite index in the
   same column order and direction, after any equality filters (the
   `sql-query-performance` skill). Keyset on a nullable column breaks (NULL compares as
   unknown); sort on a non-null column, or make NULL placement explicit
   (`NULLS LAST`) and handle the NULL segment in the predicate. Allow-list sortable
   fields; never interpolate a client column name.
4. **Make cursors opaque and bound to their query.** Base64url-encode JSON (or sign it
   with an HMAC if tampering matters) containing the key values, sort, and a hash of the
   filters. Reject a cursor used with different sort/filter parameters or with malformed
   contents with `400`, never a `500` or a silent restart from page one.
5. **Bound the page.** A default `limit` (20–50) and a hard maximum (100–200); reject
   above it with `400` (or clamp, if that is the repo's convention, and say so in the
   response). Fetch `limit + 1` rows to compute `has_more`; return `next_cursor` only
   when there is one. Offer `Link: <…>; rel="next"` if the repo uses it.
6. **Filters are typed data, never query fragments.** Each filter has a declared type
   and allowed operators (`status=open,ready`, `created_after=2026-01-01T00:00:00Z`),
   is validated at the boundary, and is bound as a parameter. Tenant/ownership scoping
   is applied server-side before any client filter (the `security-authz` skill).
   Full-text search uses the database's FTS or the search engine, with its own limits.
7. **Be honest about totals.** An exact `COUNT(*)` over a large filtered set costs as
   much as the query itself; offer it only when cheap or requested, otherwise
   `has_more` or a labelled estimate. Never compute an expensive count on every page.
8. **Keep the UI in step.** Same parameter names; active sort and filters in the URL
   (shareable, back button works); empty, loading and error states handled; filter
   changes reset the cursor (the `frontend-data-fetching` skill).

## Tests (each exercises the list behaviour itself)

- First page, middle page, last page (`has_more=false`, no `next_cursor`), empty result.
- **Concurrent writes:** fetch page 1, insert rows that sort before and after the
  boundary and delete one row on page 1, fetch page 2 → no row repeated, no existing
  row skipped. Walking all pages yields every row that existed throughout exactly
  once.
- **Ties:** ≥ `limit + 1` rows with an identical sort value paginate without loss or
  duplication (proves the tiebreaker).
- Rows with NULL in a nullable sort column all appear exactly once.
- `limit` above the maximum, unknown sort field, malformed or mismatched cursor → `400`.
- Another tenant's rows never appear, under any filter.
- The paged query's `EXPLAIN` on realistic volume shows an index scan with no sort
  node over the full table.

## Done when

The tests above pass and each acceptance criterion has evidence via the
`record-evidence` skill, including the query plan for the paged query.

## Review checklist

- [ ] Same envelope and parameter names as sibling lists.
- [ ] Keyset by default; offset justified in code where used.
- [ ] Sort total (unique tiebreaker), index-backed, NULL-safe, allow-listed.
- [ ] Cursor opaque, validated, bound to sort and filters.
- [ ] Default and maximum limit; `limit + 1` for `has_more`.
- [ ] Filters typed and parameterised; authorisation scope applied first.
- [ ] A concurrent-insert/delete paging test and a tie test exist.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While matching the list contract you learn the repo's envelope, cursor format and which columns are safe to sort on.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
