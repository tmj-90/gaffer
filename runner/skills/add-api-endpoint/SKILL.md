---
name: add-api-endpoint
description: Use when a ticket asks to add or extend an HTTP/API endpoint — a new route, handler, or RPC method — with request validation and a defined response. Invoke for "add a POST /things endpoint", "expose a list API", or "add a field to the X response".
stack: []
area: backend
---

# Add an API endpoint

Add an endpoint that follows the repo's existing routing, validation, and response
conventions, with input validated at the boundary and tests proving the contract.

## Steps

1. **Read the lore first.** Call `search_lore` (Memory MCP) for the repo's API
   conventions: routing style, request/response envelope, error format, auth/authz
   pattern, and pagination rules. Honour any ADRs you find.
2. **Find a sibling endpoint** and copy its shape — router registration, handler
   structure, DTO/schema definitions, and where validation lives.
3. **Validate input at the boundary.** Define the request schema with the repo's
   validation library (e.g. Zod, Pydantic, Bean Validation); reject malformed input
   with the project's standard error response. Never trust the client.
4. **Implement the handler** thin: validate → delegate to the service/domain layer →
   map to the standard response envelope. Apply the existing auth/authz checks.
5. **Wire it up** (register the route) and add tests: validation rejects bad input, the
   happy path returns the right status/body, and authz is enforced. Use the
   `add-integration-test` skill for the route-level test.
6. **Run tests + lint** (`run-tests`, `run-lint`). Evidence the command output and the
   changed files, then use the `record-evidence` skill and submit for review.

## Rules

- Validate every input at the boundary; never trust client data.
- Match the repo's response envelope, error format, and auth pattern — don't invent one.
- Don't widen scope (no unrequested fields or endpoints); keep to the AC.
- Flag any new auth-surface or data-exposure risk in your review reason.
- Run on a branch (the `create-branch` skill), never a protected branch.
