---
name: event-driven-messaging
description: Use when a ticket connects components through events or messages — publishing domain events, consuming from a topic or stream, an event bus, pub/sub, change-data-capture — and the design must define ownership of each event, its schema and versioning, delivery guarantees, ordering, and how consumers stay idempotent. Invoke for "emit an event when X", "subscribe to Y", "add a consumer", "events are arriving out of order", or any Kafka/SNS/SQS/NATS/Redis Streams work.
stack: [node, python, go, java, rust, csharp, kotlin, ruby]
area: backend
---

# Design event-driven messaging

Brokers deliver at least once, redeliver after crashes and rebalances, reorder across
partitions, and replay on demand. Events decouple services only when each event is an
owned, versioned contract, is published atomically with the state change (transactional
outbox), and every consumer is idempotent (inbox) and tolerant of order and replay.

## Steps

1. **Use the repo's infrastructure.** The broker, client library, topic naming, envelope
   and schema registry. Call `search_lore` for them and for declared ownership
   boundaries. One bus per repo; no new broker for one event.
2. **Design the event as a contract.** A past-tense fact (`order.placed`), owned by one
   producer. Envelope with a unique event `id`, `type`, `source`, `time`, schema
   version, `subject`/entity key and correlation id (CloudEvents names these; use them
   if the repo has no envelope). Payload: identifiers plus the facts consumers need,
   never internal table rows or secrets. Register the schema where the repo keeps them
   and pin it with a contract test (the `contract-test` skill). Additive changes only;
   a breaking change is a new event type or version (the `api-versioning` skill).
3. **Publish with a transactional outbox.** Insert the event into an outbox table in the
   same transaction as the domain write; a relay (polling with
   `FOR UPDATE SKIP LOCKED`, or log tailing/CDC such as Debezium) publishes and marks it
   sent. Publishing to the broker inside or after the transaction is a dual write: it
   emits ghosts on rollback or loses events on a crash. The relay itself delivers at
   least once, so step 5 is mandatory.
4. **Decide ordering explicitly.** If consumers need per-entity order, use the entity id
   as the partition/message-group key and keep one in-flight message per key in the
   consumer. Never promise global order. Where order cannot be guaranteed (retries,
   DLQ replays, multiple producers), carry an entity version and let consumers ignore
   anything older than what they have applied.
5. **Make consumers idempotent with an inbox.** In one transaction: insert the event id
   into a processed-events table (unique constraint), apply the effect, commit; then ack
   or commit the offset. A duplicate hits the constraint and is acked without effect.
   Ack after commit, never before; auto-commit of offsets before processing loses
   messages. Side effects outside the database take an idempotency key (the
   `idempotency-and-retries` skill).
6. **Handle failure per message.** Classify transient vs permanent; bounded retries with
   backoff; then a dead-letter topic or table with the error and original payload. A
   poison message must not block its partition indefinitely. Consumer lag, DLQ count
   and age of oldest unpublished outbox row are metrics with alerts (the
   `structured-logging-and-tracing` skill).
7. **Plan for replay and evolution.** Consumers ignore unknown fields, default missing
   ones, accept every live schema version, and are safe to replay from the start of
   retention. Document retention and the replay procedure.
8. **Test**, one test per AC exercising the AC's own behaviour, plus:
   - the event is in the outbox after commit and absent after rollback;
   - the payload validates against the registered schema;
   - the same event delivered twice produces one effect;
   - an older version arriving after a newer one does not overwrite it;
   - a consumer killed between applying the effect and acking reprocesses safely;
   - a poison message dead-letters and the next message is processed;
   - an old-schema event is handled.

   Use the broker's test container or an in-memory fake that redelivers and reorders,
   not a fake that is perfectly ordered and exactly-once.
9. **Evidence** with the `record-evidence` skill.

## Done when

- The event has an owner, a registered versioned schema and a contract test.
- Publishing goes through an outbox or CDC; no dual write remains.
- Consumers dedupe by event id in the same transaction as the effect and ack after
  commit; ordering is per key or explicitly not promised.
- Duplicate, reorder, crash-before-ack and poison-message tests pass.

## Anti-patterns

- `db.commit(); broker.publish()` or publishing inside the transaction.
- An in-memory "seen ids" set as the only dedupe (lost on restart, not shared).
- Enabling auto-commit/auto-ack and processing afterwards.
- Events named as commands (`send_email`) or carrying whole mutable entities.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While designing the event you learn the broker, the topic naming, the envelope, the outbox pattern and who owns each event.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
