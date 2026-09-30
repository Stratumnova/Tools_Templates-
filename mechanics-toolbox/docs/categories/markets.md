# Markets, stalls, and orders

Batch 6 adds a deterministic, headless market ledger. It is deliberately UI-neutral and
uses safe integers only. Money is stored in the smallest currency unit; price modifiers use
basis points, where 10000 means 1.0x.

## State

- `actorsById`: spendable balances and actor-held items.
- `stallsById`: owner, roles, categories, listed stock, and price modifiers.
- `ordersById`: funded buy orders. Maximum cost is removed from the buyer and held as escrow.
- `trades`: immutable trade facts suitable for reports and replay.

`marketTotals(state)` counts actor money plus open-order escrow and actor items plus stall
stock. The totals must remain unchanged across opening stalls, placing orders, partial fills,
full fills, and cancellation.

## Deterministic pricing

`quoteUnitPrice` multiplies the base price by integer basis-point modifiers using `BigInt`
intermediate arithmetic. It rounds half-up once at the end. No ambient time, floating-point
randomness, demand scan, or iteration order can change a quote.

## Routing

A stall is eligible when it has the item and either explicitly lists the category or one of
its roles supports the category.

- `farmer`: food, produce, seed, tool
- `beast_master`: animal, feed, medicine, tack

Routes sort by role match, then lowest quoted price, then stable stall ID. This makes NPC
routing reproducible. Add new roles through versioned data rather than silently changing old
save semantics.

## Partial fulfillment

A fill is bounded by requested quantity, remaining order quantity, and stall stock. The
seller receives the actual quoted cost. Any difference between the buyer's limit and the
quote returns to the buyer immediately. The unfilled maximum stays in escrow. Cancellation
refunds only the remaining escrow.

Every operation clones and validates first. Rejected operations do not mutate their input.
Duplicate actor, stall, order, and trade IDs are rejected.

## Engine handlers

`createMarketHandlers()` returns handlers for:

- `market.actor_created`
- `market.stall_opened`
- `market.buy_order_placed`
- `market.buy_order_fulfilled`
- `market.buy_order_cancelled`

The handlers emit fact-only events. Reducers recompute state exclusively from event payloads.
