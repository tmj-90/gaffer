# Security & Trust Model

Dispatch is a local-first backlog control plane that coding **agents** operate
directly (over MCP) while **humans** retain the authority that matters. This
document describes the trust boundaries that make that safe, and how to report
a vulnerability.

## Threat model in one line

The agents doing the work are *semi-trusted*: useful, fast, but capable of
hallucinating evidence, self-approving their own output, or leaking secrets
into logs. Dispatch is designed so that none of those failure modes can
silently corrupt the backlog or escape the box.

## Trust boundaries

### 1. Agents cannot self-approve work as `done`

`submit_ticket_for_review` is the furthest an agent can move a ticket: it lands
in `in_review`. Only a **human reviewer** can transition a ticket to `done`.
This separation is enforced in the state machine
(`src/services/transitionService.ts`), not merely by convention — the
`done` transition is gated and the MCP tool surface exposes no path to it. An
agent that "decides" its own work is complete still has to clear human review.

### 2. Acceptance criteria gate completion; evidence is the currency

A ticket's acceptance criteria are the contract its work is judged against.
ACs marked `evidence_required` only flip to `satisfied` when
`record_ac_evidence` records proof against them. The tool descriptions
instruct agents, in the strongest terms, never to fabricate evidence — and the
audit trail (below) records *that* evidence was recorded and against which AC,
so a reviewer can cross-check claims against reality.

### 3. Claim tokens are bearer credentials, stored only as hashes

Claiming a ticket returns a high-entropy `claim_token`
(`src/util/id.ts` → `newClaimToken`). The raw token is handed to the claiming
agent and **never persisted**: only its SHA-256 hash is stored
(`ticket_claims.claim_token_hash`). A database compromise therefore does not
yield usable tokens. Every subsequent write (evidence, submit, block,
heartbeat, release) must present the token, which is re-hashed and matched
against the active, unexpired claim.

### 4. The audit log and event log never contain secrets

Two append-only trails exist, and **neither records content or credentials**:

- **Event log** (`work_events`) — domain events (created, ready, claimed,
  evidence.recorded, …) with id-level payloads, written inside the same
  transaction as the change they describe.
- **Audit log** (`audit.jsonl`, beside the DB or at `DISPATCH_AUDIT`) —
  one JSON line per MCP tool call: timestamp, tool, actor, a **sanitised**
  request, and the result ids/count or error code.

The audit boundary is enforced by construction in `src/audit/redact.ts`, which
builds each audit record from an **allow-list** of safe fields:

- Claim tokens are reduced to a presence boolean (`claim_token: true`) —
  never the value, not even a hash.
- Free-text bodies (descriptions, AC text, evidence summaries, decision
  questions, block reasons) are reduced to character counts
  (`summary_chars: 142`).

An unrecognised argument can never leak, because it is simply never copied into
the record. The audit log is created `0600` and is safe to `tail`, grep, or
paste into an incident channel. Set `DISPATCH_AUDIT_OFF=1` to disable it
(not recommended outside tests).

### 5. Policy packs gate transitions

Each ticket carries a policy pack (`solo_loose`, `team_light`,
`factory_strict`, `regulated`). The transition service evaluates the active
pack on state changes — stricter packs require evidence-backed acceptance
criteria before a ticket can advance. Choosing a looser pack to dodge a gate is
called out in the tool descriptions as an anti-pattern; the pack is recorded on
the ticket and surfaced in `doctor`/`stats` so misuse is visible.

### 6. No network listener on the agent surface

The MCP server speaks **stdio only** — it opens no socket. The optional REST
API (`dispatch-api`) is a separate, explicitly-launched binary for human UIs.
The database file is created `0600` and its parent directory `0700`.

### 7. Defensive database open + version guard

`openDatabase` (`src/db/connection.ts`) enables WAL + `busy_timeout` (so the
CLI, API, and MCP server can share one file), locks new files to `0600`, and
on failure raises an **actionable** `DatabaseOpenError` instead of a raw
driver stack. A `DatabaseTooNewError` guard **refuses to open** any database
whose stamped `schema_version` is newer than the running build supports —
preventing an older binary from corrupting data written by a newer one.

## Operational checks

```bash
dispatch doctor   # schema version, table presence, counts, STALE claims, integrity
dispatch stats    # tickets by status, open decisions, active + stale claims
```

`doctor` surfaces stale active claims (leases past expiry that were never
released or heartbeated) and integrity warnings (e.g. a `claimed` ticket with
no active claim). Recover with `dispatch expire-claims`.

## Reporting a vulnerability

Please report security issues privately to the maintainers rather than opening
a public issue. Include reproduction steps and the affected version. We aim to
acknowledge within a few working days.
