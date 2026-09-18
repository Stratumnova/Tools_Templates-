# Dispatch contract

`createEngine(options)` creates one deterministic state engine. Its required options are
`initialState`, `registry`, `eventStore`, `permissionPolicy`, `idFactory`, and `clock`.
`schemaVersion` is optional and defaults to `1.0.0`.

Injected event stores must provide both the append-only public `append(events)` operation and
`beginTransaction()`. The engine rejects stores without transaction support. A transaction
must synchronously provide `append(events)`, `commit()`, and `rollback()`:

- `append` stages the complete batch privately; staged records are not visible in snapshots.
- `commit` makes the batch durable as one unit.
- `rollback` discards only that transaction's staged batch after any `append` or `commit` failure;
  it must never remove records committed by another transaction.
- `beginTransaction` itself must not mutate the log before returning the rollback-capable
  transaction.

Transactions may overlap. Their batches become visible in commit order, and rolling back an older
transaction does not affect a newer transaction that has already committed.

The built-in event store follows this protocol and retains no failed batch. Injected stores are
responsible for honoring the same rollback guarantee; a rollback failure is a corrupted store
invariant and may throw.

Handlers registered by command type provide two functions:

```js
{
  decide(state, command, context),
  reduce(state, event),
}
```

`decide` returns the complete shape produced by `accept(events)` or
`reject(code, message, details)`. Malformed accepted or rejected results are programming errors
and throw before reduction or storage. The frozen context is
bound to the current command and exposes `createEvent(type, payload)`, which supplies the
injected event ID, time, command ID, actor ID, room ID, and schema version. Every accepted event
must be the exact frozen object returned by that factory during the current dispatch; external
events, events from another dispatch, and clones are rejected. `reduce` returns the next state and
must be pure.

## Dispatch order

For every command, `dispatch` performs these stages in order:

1. Validate and copy the command contract.
2. Compare `expectedRevision` with the current revision.
3. Check the actor's command-type capability.
4. Resolve the registered handler and call `decide`.
5. Require a dense event array, then validate every event and its current-dispatch factory origin.
6. Reduce all events into temporary state.
7. Append all events atomically.
8. Publish the new state and add one revision per event.

Zero-event acceptance publishes no state change and does not increment the revision.

Expected failures return a structured rejected result. Stable engine codes are
`INVALID_COMMAND`, `INVALID_EVENT`, `STALE_REVISION`, `PERMISSION_DENIED`, and
`UNKNOWN_COMMAND`. Handler rejections pass through unchanged. Programming errors from
handlers and corrupted invariants may throw.

No failed or rejected dispatch publishes state, changes revision, or retains an event. Store
snapshots and accepted event arrays are immutable copies and cannot mutate the event log.
Event payloads recursively isolate and freeze nested plain objects and arrays without freezing
caller-owned input.

## Immutable data domain

Command and event payloads use a JSON-like immutable data domain: `null`, booleans, strings,
finite numbers, dense arrays, and plain objects with enumerable string-keyed data properties.
Values are recursively copied into new arrays/objects and frozen. Shared acyclic values may be
copied more than once; cycles are rejected.

Functions, `undefined`, bigint, symbols, non-finite numbers, `Date`, `Map`, `Set`, typed arrays,
class instances, accessors, symbol-keyed or non-enumerable properties, sparse arrays, and cycles
are outside the domain and throw `TypeError`. Validation reads property descriptors rather than
invoking getters. Unsupported command payloads are normalized by `dispatch` to
`INVALID_COMMAND`; unsupported payloads emitted by handlers are programming errors and throw.

The registry snapshots the validated `decide` and `reduce` function references into an immutable
handler record. Mutating the caller's handler after registration cannot change dispatch behavior,
and `registry.get()` cannot be used to invalidate a registered handler.

Permissions are explicit: `createPermissionPolicy` denies unknown actors and missing grants,
allows a matching command-type grant, and treats `*` as a wildcard grant.
