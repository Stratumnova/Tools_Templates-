# Batch 7 Agents and Routines — Design Specification

## Purpose

Batch 7 adds a deterministic decision layer for NPCs and future wildlife without replacing
any accepted Batch 1–6 authority. An agent evaluates facts, selects an existing command, and
records why that choice won. Existing systems remain responsible for mutation.

## Non-drift boundary

Batch 7 is subordinate to the existing engine:

- `engine.dispatch(command)` remains the only mutation ingress.
- The permission policy controls every agent-issued command.
- Task, inventory, crafting, time, offline, and market modules remain authoritative.
- Agent decisions emit resolved facts; reducers never rescore historical choices.
- Player and NPC actors share command types. Agent automation is only another command source.

No Batch 7 module may directly change inventory stacks, reservations, tasks, production jobs,
stall stock, orders, balances, clocks, or event history.

## Module boundaries

### `src/agents/needs.js`

Validates need definitions and state. Applies deterministic integer decay over explicit
intervals. A need defines stable ID, minimum, maximum, initial value, decay per interval,
weight, and urgency curve. Values clamp; overflow and backward time reject.

### `src/agents/skills.js`

Validates role and skill records. Skill values are safe integers. Roles are data labels and
eligibility requirements, not permission grants.

### `src/agents/memory.js`

Stores bounded factual observations. Each entry records stable ID, kind, subject, explicit
sequence, salience, and immutable JSON data. Capacity eviction sorts by lowest salience,
oldest sequence, then stable memory ID. Accessors, cycles, sparse arrays, and inherited keys
reject without execution.

### `src/agents/routines.js`

Defines recurring time windows and produces eligible routine candidates using the existing
simulation clock. It does not advance time or create tasks.

### `src/agents/utility.js`

Scores candidates with safe integer arithmetic from recorded inputs: need pressure, routine
priority, role/skill fit, memory evidence, task urgency, switching cost, and explicit
modifiers. Stable tie order is score descending, priority descending, candidate ID ascending.
Ambient randomness is forbidden.

### `src/agents/selection.js`

Chooses retain, start, interrupt, resume, or idle. It records the complete candidate score
breakdown, winner, losing candidates, decision sequence, and interruption reason. Reducers
apply the recorded winner without rescoring.

### `src/agents/agents.js`

Validates aggregate agent state: identity, actor binding, needs, skills, roles, memory,
routine assignments, current goal, suspended goal, and last decision sequence.

### `src/agents/handlers.js`

Exposes engine handlers for agent registration, need advancement, memory observation,
decision recording, goal interruption, goal resumption, and goal completion. Handler
decisions inject `command.actorId`; payload actor IDs cannot override ownership.

## State ownership and data flow

1. Existing modules expose immutable state facts.
2. Candidate builders translate those facts into possible existing commands.
3. Utility scoring resolves every score component once.
4. Selection emits an `agent.decision_recorded` fact containing the winner and score table.
5. The agent controller submits the winning existing command through `engine.dispatch`.
6. The owning Batch 1–6 reducer applies the mutation.
7. Resulting events become new observations for the next decision.

The agent reducer stores intent and evidence only. It never performs the selected gameplay
action itself.

## Interruptions and resumption

An active goal is retained unless a challenger exceeds it by the configured interrupt
margin or a hard interruption applies. Hard interruptions are explicit facts such as lost
reservation, invalid target, critical need, or revoked capability. Suspended goals retain
their original command proposal and evidence but must be revalidated before resumption.
Revalidation submits a fresh command; historical decisions remain unchanged.

## Offline behavior

Offline agent work uses the existing bounded offline intervals. Each claimed interval may
produce at most the configured number of decisions and task transitions. Duplicate interval
claims reproduce stored facts and cannot create new memories, goals, reservations, crafts,
stock, or trades.

## Stall-worker acceptance scenario

The first integrated agent is a stall worker with Farmer or Beast Master role data:

1. Observe low stall stock.
2. Record the observation in bounded memory.
3. Generate craft/restock and routine candidates.
4. Select craft/restock deterministically.
5. Dispatch existing task and crafting commands.
6. Dispatch existing stock-transfer command or the narrow Batch 7 adapter command approved
   for moving owned inventory into an owned stall.
7. Dispatch the existing Batch 6 fulfillment command as the stall owner.
8. Confirm exact inventory and currency conservation.
9. Replay the recorded events after price or need changes and reproduce the same outcome.

If Batch 6 lacks the required owned restock command, Batch 7 may add that command to the
market module as a separately tested compatibility extension. It may not write stall stock
directly.

## Failure rules

- Invalid definitions reject before IDs or events are consumed.
- Failed decisions publish no partial state.
- Duplicate decision, memory, and goal IDs reject.
- Stale sequences and terminal goals reject.
- Unsafe arithmetic rejects rather than rounding or wrapping.
- Unknown commands, revoked capabilities, missing reservations, and closed orders remain
  failures of their authoritative modules.
- Hostile JSON is rejected consistently with Batch 5–6 hardening.

## Test strategy

Tests proceed from isolated contracts to integration:

1. Need validation and decay boundaries.
2. Skills and role validation.
3. Memory capacity and deterministic eviction.
4. Routine eligibility at exact boundaries.
5. Utility arithmetic and tie ordering.
6. Retain/interrupt/resume transition matrix.
7. Fact-only decision replay after inputs change.
8. Ownership, capability, stale-event, duplicate-ID, and hostile-data attacks.
9. Offline idempotency.
10. Stall worker crafting, stocking, and order fulfillment through existing modules.
11. Complete Batch 1–7 suite and every headless example.

## Excluded from Batch 7

- Wildlife populations, habitats, evidence, hunting, and traps.
- Movement and UI view models.
- Persistence adapters, room-transfer envelopes, and Portal integration.
- Final artwork, animation, or balance tuning.
