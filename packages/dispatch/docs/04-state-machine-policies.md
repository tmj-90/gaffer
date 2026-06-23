# Dispatch state machine and policy packs

## Verdict

Statuses must not be raw mutable fields. Dispatch should centralise transitions and evaluate optional policy packs at transition time.

## Ticket states

```text
draft
refining
ready
claimed
in_progress
blocked
in_review
done
failed
cancelled
```

## State meanings

### draft

The work exists but is not yet executable.

Typical source:

- PM idea
- human note
- idle loop output
- imported issue
- rough agent suggestion

### refining

The ticket is being shaped into executable work.

Allowed activities:

- add repos
- add AC
- add risk level
- add decisions
- add verification expectations

### ready

The ticket is executable under the selected policy pack.

Agents can claim it if:

- no blocking decisions
- capability policy passes
- risk policy passes
- no active claim

### claimed

An agent has leased the ticket but may not have started implementation yet.

This is useful because context-packet generation, branch creation and repo checks happen between claim and implementation.

### in_progress

An agent is actively working.

### blocked

The ticket cannot proceed until something changes.

Blocker types:

- decision blocker
- dependency blocker
- repo access blocker
- failing environment blocker
- human clarification blocker

### in_review

The implementation is ready for review.

### done

The ticket has passed whatever done policy is active.

### failed

The ticket failed in a way that needs intervention or retry logic.

### cancelled

The ticket is intentionally closed without completion.

## Allowed transitions

```text
draft → refining
draft → ready
refining → ready
ready → claimed
claimed → in_progress
claimed → ready
claimed → blocked
in_progress → blocked
in_progress → in_review
in_progress → failed
blocked → ready
blocked → refining
in_review → done
in_review → ready
in_review → refining
ready → cancelled
refining → cancelled
draft → cancelled
failed → ready
failed → refining
ready → draft
refining → draft
```

`ready → draft` / `refining → draft` are the reversible "un-ready" moves a human
or admin performs from the board (drag a card back to Draft, or the card's status
menu). They are always safe — `ready`/`refining` never hold an active claim, so
un-readying can never touch in-flight agent work. The forward moves
(`draft → ready`, `refining → ready`) remain policy-gated; the reverse needs no
gate. These are surfaced as a guarded `move` capability (`POST /tickets/:id/move`,
`Dispatch.moveTicket`, `wg ticket move`) that runs through the same
`TransitionService`, so every other guard (illegal-transition rejection, policy
gates on gated targets, optimistic concurrency) still applies.

## Disallowed examples

```text
draft → done
ready → done
blocked → done
in_progress → done
claimed → done
cancelled → ready, unless admin reopens
```

## Transition functions

Recommended core API:

```text
transition_ticket(
  ticket_id,
  actor,
  from_status,
  to_status,
  reason,
  claim_token optional,
  policy_pack optional,
  payload optional
)
```

The implementation should:

1. load the ticket in a transaction
2. verify current state matches `from_status`
3. verify actor permission
4. verify active claim if required
5. evaluate policy checks
6. update state
7. write event
8. return new state and event ID

## Claim expiry transition

Claim expiry is not a user action. It is a system recovery action.

```text
claimed/in_progress + expired claim → ready or blocked
```

If the ticket has unresolved blocking decisions, return it to `blocked`, otherwise return it to `ready`.

## Policy packs

Policies should be optional and composable.

### solo_loose

For one user using local SQLite.

Readiness:

- title required
- description recommended
- AC optional
- repo optional, but warned

Claim:

- no active claim
- no human_required blocker

Review/done:

- PR optional
- AC evidence optional

### team_light

For small teams.

Readiness:

- title required
- description required
- at least one repo required
- at least one AC required
- no unresolved human_required blocker

Claim:

- no active claim
- agent capability should match required tags if present

Review/done:

- all non-waived AC resolved
- PR or diff summary required

### factory_strict

For multi-agent shared execution.

Readiness:

- title required
- description required
- repo required
- AC required
- verification method required per AC
- risk level required
- reviewer required
- no unresolved blocking decision

Claim:

- no active claim
- agent capabilities cover ticket requirements
- agent max risk covers ticket risk
- branch policy can be generated

Review/done:

- all required AC satisfied
- evidence required for each AC
- branch recorded
- PR recorded or explicit waiver
- test result or explicit waiver
- no unresolved new decision
- Memory suggestion considered

### regulated

For heavily controlled environments.

Readiness:

- all factory_strict checks
- human approval required before ready
- owner required
- security owner required for high-risk areas

Review/done:

- immutable evidence required
- human reviewer required
- security reviewer required for security risk
- event log must be complete
- no auto-done

## Policy evaluation result

Return a structured result:

```json
{
  "allowed": false,
  "policy_pack": "factory_strict",
  "transition": "in_progress_to_in_review",
  "failures": [
    {
      "code": "AC_EVIDENCE_MISSING",
      "message": "AC 3 requires evidence before review."
    }
  ],
  "warnings": []
}
```

## Risk policy

Risk level should not be hardcoded as a blocker. It should feed policies.

Example:

```text
low: any agent can claim if capable
medium: tests required
high: human readiness approval required
critical: plan-before-implementation required
```

## Plan-before-implementation

Optional extension for risky tickets:

```text
ready_for_plan
planning
plan_review
ready
```

Do not add this to v1 unless high-risk workflows are central.

## Done eligibility

Computed field:

```text
done_eligible = policy(done_transition).allowed
```

Do not store this as authoritative state unless cached for performance.
