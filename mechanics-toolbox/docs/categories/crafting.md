# Crafting and production

Version 0.5.0 adds deterministic recipe matching and engine-backed production. It composes
the Batch 3 inventory reservation contract with the Batch 4 task-resource reservation
model. Inventory reservations remain in `reservationsById`; exclusive station reservations
use `taskReservationsById`. Production state also contains `craftJobsById` and
`stationsById`.

## Recipes and matching

`validateRecipe(recipe, options?)` returns an isolated, deeply immutable recipe. Recipe,
item, group, tool, skill, station-tag, job, and reservation identifiers use the shared
stable-identifier grammar. Arrays are dense and duplicate-free within their declared
domain. Durations and quantities are positive safe integers; difficulty is an integer from
0 through 100. `options.existingRecipesById` can reject a duplicate recipe ID.

Inputs are matched in recipe order. Exact inputs are followed by substitution groups in
group order; each group exhausts option order before moving to the next option. Inventory
stack order is always preserved. The matcher does not rank values or quality. Tools use
the first available stack that meets `minDurability`; they are checked but not consumed or
reserved unless the same item is separately declared as an input. Every station tag must
be present.

## Production lifecycle

`queueProduction` preflights the complete operation, then reserves each exact ingredient
selection and the station atomically. It records the chosen inputs, tools, quality, products,
byproducts, generated IDs, complete input allocation snapshots, and the exact station
reservation generation in an immutable `QUEUED` job. Starting a job records `startedAt`
and the safe-integer sum `endsAt = startedAt + durationMs`. Every transition requires the
live reservations to match those stored facts exactly; releasing and recreating a record
under the same ID does not transfer ownership to the job.

An `ACTIVE` job can complete at or after `endsAt`. Completion consumes the recorded
inventory reservations, creates exactly the recorded outputs and declared byproducts,
releases the station, and moves the job to `COMPLETED`. Cancelling a `QUEUED` or `ACTIVE`
job releases each unconsumed reservation and moves it to `CANCELLED` without output.
Terminal jobs reject every later transition. Actor and station identity are checked on all
transitions. Stored jobs are fully schema- and chronology-validated before use.

Direct helpers return `{ state, job, event }` drafts without mutating callers. Player and
NPC changes should use `engine.dispatch` with the handlers from
`createCraftingHandlers({ recipesById, definitionsById, nextCraftJobId,
nextReservationId, nextStackId })`. The neutral commands are `craft.queue`,
`craft.start`, `craft.complete`, and `craft.cancel`; corresponding events record all facts
needed for replay. Reducers do not choose inputs, calculate quality, infer byproducts, or
generate IDs. Completion events contain concrete per-product stack placement facts,
including before/after stacks and every generated stack ID. Replay validates and applies
those facts directly, so changing definitions later cannot change historical placement.
Missing, surplus, reused, or incompatible placement IDs reject.

Definitions, recipe maps, and auxiliary options are copied through the JSON-like data
boundary. Accessors and hostile values reject with stable `craft.*` codes, while caller
objects remain mutable and unfrozen. Every resolved definition map key must equal its
`definition.itemId`. Handler factories are the only documented function-valued options.

## Quality

`calculateQuality` returns an integer on a documented 0–100 scale. Its inputs are skill,
difficulty, tool condition, and input quality on 0–100 scales plus an explicit roll on the
closed interval 0–1:

```text
round(clamp(50 + skill - difficulty
  + 0.2 × (toolCondition - 50)
  + 0.2 × (inputQuality - 50)
  + 20 × (roll - 0.5), 0, 100))
```

Missing or out-of-range rolls reject. No crafting API reads ambient randomness, time, or
locale. Non-numeric inventory quality contributes the neutral value 50, and multiple input
or tool values use quantity-weighted input quality and arithmetic-mean tool condition.

Run `node examples/headless/npc-crafts-trap.mjs` for a complete reserve, queue, start, and
complete chain through the real engine.
