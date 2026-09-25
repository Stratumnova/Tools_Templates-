# Time and tasks

Version 0.4.0 adds deterministic simulation clocks, arithmetic schedules, task lifecycles,
exclusive task-resource reservations, and idempotent offline advancement.

All timestamps are non-negative safe integers in simulation milliseconds. No API reads the
wall clock, locale, timezone, or randomness. Offline completion decisions are recorded as
events before reducers apply their facts, so replay does not make a second decision.

Task statuses progress through `AVAILABLE`, `CLAIMED`, `ACTIVE`, and optionally
`INTERRUPTED` before a terminal `COMPLETED`, `FAILED`, or `CANCELLED` state. Claims and
active transitions enforce actor ownership. Resource types are `worker`, `station`, `route`,
and `target`, with one active reservation for each derived resource key.

Use `createTimeTaskHandlers()` to register `clock.advance`, `task.*`, and
`offline.advance` with the core command engine.
