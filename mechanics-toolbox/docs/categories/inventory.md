# Inventory

Batch 3 adds deterministic, in-memory inventory operations over the state shape
`{ containersById, reservationsById }`. Containers use a non-negative integer
`capacity` measured in total units, not stack count.

Item definitions declare identifiers, display labels, tags, stack limits, and durability.
Durable items use either a `remove` break policy or a `scrap` policy whose `scrapItemId`
must resolve to a fully validated terminal item with `durability.enabled === false`. Durable
scrap targets and scrap chains are invalid. Replacement scrap always has `durability: null`.
`validateItemDefinition` returns an isolated copy.

Stacks combine only when item ID, quality, durability, and structurally equal metadata all
match. `addItem` and `transferItem` require the relevant definition and an injected
`nextStackId` whenever a new stack is needed. All operations return isolated state and
leave caller-owned state and inputs unchanged.

Reservations retain physical units in their stacks while reducing availability. Each
reservation records exact stack allocations and trait snapshots. Releasing restores
availability; consuming removes the recorded units and deletes the reservation. Transfers
and durability damage cannot spend or alter reserved units.

`createInventoryHandlers({ definitionsById, nextStackId })` returns registry-ready handlers
for `inventory.add`, `inventory.remove`, `inventory.transfer`,
`inventory.damage_durability`, `inventory.reserve`, `inventory.release_reservation`, and
`inventory.consume_reservation`. Decisions use the Batch 2 command-bound event factory;
reducers remain pure. Direct operations throw errors with stable `inventory.*` codes,
while handlers convert those errors into rejected decisions.

Durability damage returns `{ state, event }`. Non-breaking damage returns `event: null`.
Breakage returns an `inventory.item_broken` draft and applies the configured remove or
scrap policy without writing to an event store.
