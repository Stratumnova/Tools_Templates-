# Markets, stalls, and orders

Batch 6 provides a deterministic market ledger for browser and Android WebView runtimes.
Money uses safe integers in the smallest currency unit. Price modifiers use basis points,
where 10000 means 1.0x.

## State and conservation

- `actorsById`: spendable balances and actor-held items.
- `stallsById`: owner, roles, categories, isolated stock, per-item prices, and modifiers.
- `ordersById`: fully funded buy orders with deterministic expiration sequences.
- `trades`: validated resolved facts used for reports and replay.

`marketTotals(state)` counts actor money plus open escrow and actor items plus stall stock.
Opening stalls, placing orders, partial fills, terminal fills, cancellation, and expiration
must conserve those totals. Every price, product, sum, refund, and balance is checked against
the JavaScript safe-integer boundary.

## Deterministic pricing

A stall supplies the base item price through `prices[itemId]`. For backward-compatible
fixtures without a price, the buyer limit is the fallback base. `quoteUnitPrice` applies
integer basis-point modifiers with `BigInt` intermediate arithmetic and rounds half-up
once at the end.

Fulfillment events record the resolved base price, both modifiers, final unit price, actual
quantity, total, released escrow, refund, and sequence. Reducers verify those recorded facts
but never select a new stall or re-read the stall's current price. Replaying an old event
therefore reproduces the old trade even if later market prices differ.

## Routing

A stall is eligible when it owns positive stock and either explicitly serves the requested
category or one of its roles supports it.

- `farmer`: food, produce, seed, tool
- `beast_master`: animal, feed, medicine, tack

Routes sort by role match, quoted price, then stable stall ID. Ambiguous category matches use
that order. Unroutable items return an empty route list. Closed orders cannot be routed.

## Ownership and terminal rules

The engine injects `command.actorId`; payload actor IDs cannot override it.

- Only the buyer can place or cancel its order.
- Only the stall owner can fulfill through that stall.
- Buyer and seller must differ.
- Cancellation refunds exact remaining escrow.
- Expiration is allowed only at or beyond `expiresSequence`.
- Filled, cancelled, and expired orders are terminal.
- Trade and order IDs cannot be reused.

Open-order escrow must equal `remaining * limitUnitPrice`. Recorded trade quantities must
agree with the order remainder. Duplicate or malformed persisted trades reject the entire
state.

## Hostile-data boundary

Market input rejects accessors without invoking them, inherited records, unsafe property
names, symbols, non-enumerable data, sparse arrays, cycles, non-finite numbers, and unsafe
integer arithmetic. Operations clone and validate before mutation, so rejection cannot
publish partial state or retain caller-owned mutable references.

## Command handlers

Canonical commands returned by `createMarketHandlers()`:

- `market.actor_create`
- `market.stall_open`
- `market.buy_order_place`
- `market.buy_order_fulfill`
- `market.buy_order_cancel`
- `market.buy_order_expire`

Legacy Batch 6 command aliases remain during the 0.6 transition. All accepted mutations emit
command-bound facts through the core engine.
