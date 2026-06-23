# Dispatch MCP tool plan

## Tool design principles

1. Tools should express domain actions, not raw SQL.
2. Agents should not mutate arbitrary status fields.
3. State transitions must go through Dispatch core.
4. Tool access should be scoped by actor role and claim token.
5. Write tools should return event IDs for auditability.
6. Where possible, tools should return the next useful action.

## Actor types

```text
human
agent
admin
system
```

## Human-facing tools

These can be exposed to AI clients acting for a human, but they should usually require human credentials.

### create_ticket

Creates a draft ticket.

Request:

```json
{
  "title": "Add password reset",
  "description": "Users need to request a reset email and set a new password.",
  "repos": ["auth-service", "web-app"],
  "priority": 50,
  "source": "human",
  "tags": ["auth", "user-account"]
}
```

Response:

```json
{
  "ticket_id": "ticket_123",
  "number": 123,
  "status": "draft",
  "event_id": "event_001"
}
```

### add_acceptance_criterion

Adds AC to a ticket.

Request:

```json
{
  "ticket_id": "ticket_123",
  "text": "Reset tokens expire after 30 minutes.",
  "verification_method": "integration_test",
  "evidence_required": true
}
```

Response:

```json
{
  "ac_id": "ac_456",
  "event_id": "event_002"
}
```

### request_decision

Creates a decision and optionally links it to tickets.

Request:

```json
{
  "title": "Choose reset token expiry",
  "question": "Should reset tokens expire after 15 or 30 minutes?",
  "severity": "human_required",
  "decision_type": "security",
  "ticket_ids": ["ticket_123"],
  "relation": "blocks"
}
```

Response:

```json
{
  "decision_id": "decision_789",
  "status": "human_required",
  "event_id": "event_003"
}
```

### resolve_decision

Resolves a decision.

Request:

```json
{
  "decision_id": "decision_789",
  "resolved_answer": "Use 30 minutes for normal reset tokens and 10 minutes for admin accounts.",
  "resolution": "accepted",
  "create_memory_suggestion": true
}
```

Response:

```json
{
  "decision_id": "decision_789",
  "status": "accepted",
  "event_id": "event_004",
  "memory_suggestion_id": "lg_suggestion_321"
}
```

### mark_ticket_ready

Attempts to move a ticket to `ready` under a policy pack.

Request:

```json
{
  "ticket_id": "ticket_123",
  "policy_pack": "team_light"
}
```

Response if allowed:

```json
{
  "ticket_id": "ticket_123",
  "status": "ready",
  "event_id": "event_005"
}
```

Response if denied:

```json
{
  "allowed": false,
  "reason": "Ticket requires at least one repository and one acceptance criterion under team_light.",
  "missing": ["acceptance_criteria"]
}
```

## Agent-facing tools

### claim_next_ticket

Claims the next executable ticket for an agent. This is the key queue operation.

Request:

```json
{
  "agent_id": "claude-auth-01",
  "capabilities": ["backend", "auth", "tests"],
  "max_risk": "medium",
  "repo_filter": ["auth-service"],
  "lease_minutes": 30
}
```

Response if found:

```json
{
  "claimed": true,
  "ticket_id": "ticket_123",
  "claim_id": "claim_abc",
  "claim_token": "opaque-token-return-once",
  "expires_at": "2026-06-20T12:30:00Z",
  "work_packet": {
    "ticket": {},
    "acceptance_criteria": [],
    "repos": [],
    "decisions": [],
    "relevant_lore": [],
    "policy": {},
    "branch_policy": {}
  },
  "event_id": "event_006"
}
```

Response if none:

```json
{
  "claimed": false,
  "reason": "No ready unblocked tickets match agent capabilities.",
  "suggested_next_action": "run_idle_loop"
}
```

### get_ticket

Reads a ticket and related data.

Request:

```json
{
  "ticket_id": "ticket_123"
}
```

Response:

```json
{
  "ticket": {},
  "repos": [],
  "acceptance_criteria": [],
  "decisions": [],
  "claims": [],
  "latest_events": []
}
```

### heartbeat_claim

Extends or confirms an active claim.

Request:

```json
{
  "claim_id": "claim_abc",
  "claim_token": "opaque-token-return-once",
  "extend_minutes": 30
}
```

Response:

```json
{
  "claim_id": "claim_abc",
  "status": "active",
  "expires_at": "2026-06-20T13:00:00Z",
  "event_id": "event_007"
}
```

### record_branch

Records the branch used for a ticket or ticket repo.

Request:

```json
{
  "ticket_id": "ticket_123",
  "claim_token": "opaque-token-return-once",
  "repo": "auth-service",
  "branch_name": "dispatch/TICKET-123-password-reset"
}
```

Response:

```json
{
  "event_id": "event_008"
}
```

### record_ac_evidence

Records evidence for an AC.

Request:

```json
{
  "ticket_id": "ticket_123",
  "ac_id": "ac_456",
  "claim_token": "opaque-token-return-once",
  "status": "satisfied",
  "evidence_type": "test_output",
  "summary": "Password reset integration test passed.",
  "payload": {
    "command": "pytest tests/integration/test_password_reset.py",
    "exit_code": 0,
    "output_excerpt": "1 passed"
  }
}
```

Response:

```json
{
  "ac_id": "ac_456",
  "status": "satisfied",
  "evidence_id": "ev_123",
  "event_id": "event_009"
}
```

### mark_ticket_blocked

Marks the ticket blocked by a new or existing decision.

Request:

```json
{
  "ticket_id": "ticket_123",
  "claim_token": "opaque-token-return-once",
  "decision": {
    "title": "Email provider choice",
    "question": "Should the reset email use SES or existing notification-service?",
    "severity": "human_required",
    "decision_type": "product"
  }
}
```

Response:

```json
{
  "ticket_id": "ticket_123",
  "status": "blocked",
  "decision_id": "decision_222",
  "event_id": "event_010"
}
```

### submit_ticket_for_review

Submits a ticket for human or reviewer inspection.

Request:

```json
{
  "ticket_id": "ticket_123",
  "claim_token": "opaque-token-return-once",
  "summary": "Implemented password reset in auth-service and web-app.",
  "pr_urls": [
    "https://github.com/org/auth-service/pull/44",
    "https://github.com/org/web-app/pull/91"
  ],
  "known_limitations": []
}
```

Response if allowed:

```json
{
  "ticket_id": "ticket_123",
  "status": "in_review",
  "event_id": "event_011"
}
```

Response if denied:

```json
{
  "allowed": false,
  "reason": "AC 2 has no evidence under the current policy pack.",
  "missing": ["evidence:ac_2"]
}
```

### release_ticket_claim

Releases a ticket back to ready or blocked state.

Request:

```json
{
  "claim_id": "claim_abc",
  "claim_token": "opaque-token-return-once",
  "reason": "Cannot reproduce issue locally. Releasing for another agent."
}
```

Response:

```json
{
  "claim_id": "claim_abc",
  "ticket_id": "ticket_123",
  "ticket_status": "ready",
  "event_id": "event_012"
}
```

## Review/admin tools

### list_blocked_tickets

Returns tickets blocked by decisions.

### list_pending_decisions

Returns unresolved decisions.

### list_stale_claims

Returns claims with expired heartbeat or expiry.

### requeue_ticket

Admin action to return failed, stale or rejected tickets to ready/refining.

### reject_ticket_review

Human reviewer returns a ticket to ready or refining with reasons.

### mark_ticket_done

Human or policy-approved system action moves `in_review` to `done`.

## Tool permission matrix

| Tool | Human | Agent | Admin | Notes |
|---|---:|---:|---:|---|
| create_ticket | yes | optional | yes | agent-created tickets default to draft |
| add_acceptance_criterion | yes | optional | yes | policy may require human approval |
| mark_ticket_ready | yes | no by default | yes | can be delegated in solo mode |
| claim_next_ticket | no | yes | yes | atomic claim |
| heartbeat_claim | no | yes | yes | requires claim token |
| record_ac_evidence | no | yes | yes | requires claim token |
| mark_ticket_blocked | yes | yes | yes | agent can request blocker |
| resolve_decision | yes | no by default | yes | security decisions may require special scope |
| submit_ticket_for_review | no | yes | yes | requires claim token |
| mark_ticket_done | yes | no by default | yes | can be policy automated later |

## Error model

Use structured errors:

```json
{
  "error": {
    "code": "CLAIM_TOKEN_INVALID",
    "message": "The claim token does not match the active claim for this ticket.",
    "recoverable": false
  }
}
```

Suggested codes:

```text
TICKET_NOT_FOUND
AC_NOT_FOUND
DECISION_NOT_FOUND
INVALID_STATE_TRANSITION
POLICY_CHECK_FAILED
CLAIM_NOT_FOUND
CLAIM_EXPIRED
CLAIM_TOKEN_INVALID
CAPABILITY_MISMATCH
RISK_POLICY_BLOCKED
BLOCKING_DECISION_EXISTS
CONCURRENT_UPDATE_CONFLICT
PERMISSION_DENIED
```
