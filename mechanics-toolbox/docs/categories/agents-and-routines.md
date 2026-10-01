# Agents and routines

Batch 7 supplies a deterministic decision layer for player, NPC, wildlife, and offline
actors. It does not replace the state authorities from Batches 1–6. Inventory, tasks,
crafting, markets, clocks, permissions, and event history remain owned by their existing
modules.

## Boundary

Agent modules validate and update only agent-owned state. They may select a command proposal,
but gameplay mutation still enters through a separate `engine.dispatch(command)` call. A
proposal is therefore safe to inspect, store, reject, or route through a different host.

The stall-worker adapter uses `indexed-proposals-only` mode. It groups
`production.queue` and `market.buy_order_fulfill` templates for lookup and deterministic
selection without making the crafting and market systems communicate directly.

## Determinism

- Need decay uses explicit integer sequences and complete intervals.
- Routine windows are start-inclusive, end-exclusive, and never wrap a period.
- Utility scoring checks every multiplication and sum for safe-integer overflow.
- Ties resolve by total score, priority, and stable candidate ID.
- Decision facts record the full ranking and component breakdown.
- Reducers apply recorded facts without rescoring or rereading current prices.
- Offline decisions are bounded, chronological, interval-idempotent, and use injected IDs.

## Agent lifecycle

Agents can be idle, start or retain a goal, interrupt and suspend it, resume it, and complete
it. Completed goals are terminal. Duplicate decision IDs and stale sequences reject before
state publication.

## Public modules

- `needs.js`: need definitions, state creation, and decay.
- `skills.js`: skill profiles and role sets.
- `memory.js`: immutable bounded observations with deterministic eviction.
- `routines.js`: recurring eligibility windows.
- `utility.js`: weighted integer scoring and stable ranking.
- `agents.js` and `selection.js`: aggregate state and recorded decisions.
- `handlers.js`: capability-controlled engine commands.
- `offline.js`: bounded offline decision advancement.
- `stall-worker.js`: indexed crafting and fulfillment proposals.
