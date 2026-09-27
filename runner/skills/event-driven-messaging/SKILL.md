---
name: event-driven-messaging
description: Use when a ticket connects components through events or messages — publishing domain events, consuming from a topic or stream, an event bus, pub/sub, change-data-capture — and the design must define ownership of each event, its schema and versioning, delivery guarantees, ordering, and how consumers stay idempotent. Invoke for "emit an event when X", "subscribe to Y", "add a consumer", "events are arriving out of order", or any Kafka/SNS/SQS/NATS/Redis Streams work.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Design event-driven messaging

Events decouple producers from consumers only when the event is a stable, owned
contract and the consumers tolerate the realities of messaging: duplicates, reordering,
delays, and replays. Design the event as an API, publish it atomically with the state
change, and make every consumer idempotent and observable.

## Steps

1. **Use the repo's messaging infrastructure and conventions.** The broker, the client
   library, the topic naming scheme, the envelope, the schema registry if any. Call
   `search_lore` for these and for declared boundaries. One bus per repo.
2. **Design the event as a contract.** Past-tense name for a fact that happened
   (`order.placed`, not `place_order`); a versioned schema with identifiers and the
   minimal facts consumers need; a stable event id, occurred-at time, producer, and
   correlation id in the envelope. Register it where the repo keeps schemas and pin it
   with a contract test (the `contract-test` skill). Additive changes only; a breaking
   change is a new version (the `api-versioning` skill).
3. **Publish atomically with the state change.** Write the event to an outbox table in
   the same transaction as the domain write and relay it to the broker (transactional
   outbox), or use the database's CDC. Publishing directly from application code after a
   commit loses events on crashes; publishing before commit emits ghosts.
4. **Choose ordering and partitioning deliberately.** If consumers need order for an
   entity, partition by that entity's key; otherwise do not promise order. Never rely on
   global order.
5. **Make consumers idempotent.** Store processed event ids (or the entity version) and
   skip duplicates; make handlers safe under redelivery (the `idempotency-and-retries`
   skill); handle out-of-order by comparing versions or timestamps rather than assuming
   sequence.
6. **Handle failure per message.** Bounded retries with backoff, then a dead-letter
   topic with the reason; a poison message must not block the partition forever;
   consumer lag and dead-letter counts are metrics with alerts.
7. **Plan for replay and schema evolution.** Consumers must tolerate old versions of an
   event (defaults for new fields, ignore unknown fields) and be safe to replay from
   the beginning; document the retention of the topic.
8. **Test**: the event is emitted with the state change and not on rollback, the schema
   validates, a duplicate is skipped, an out-of-order pair converges, a poison message
   dead-letters without blocking, an old-version event is handled. Evidence with the
   `record-evidence` skill.

## Rules

- Events are owned, versioned, past-tense contracts with a registered schema.
- Transactional outbox or CDC; never fire-and-forget from application code.
- Order is promised per partition key or not at all.
- Every consumer is idempotent and tolerant of reordering and replay.
- Bounded retries, dead-letter with reason, lag and DLQ metrics alerted.
- Additive schema evolution; breaking changes are new versions.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While designing the event you learn the broker, the topic naming, the envelope, the outbox pattern and who owns each event.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
