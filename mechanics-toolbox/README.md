# A25 Mechanics Toolbox

Version 0.7.0 provides deterministic core, inventory, time, task, reservation, offline,
crafting, market, and agent-routine mechanics for browser and Android WebView runtimes.

Run `npm test` for the complete suite or `node examples/headless/npc-crafts-trap.mjs` for
an engine-backed production example. See `docs/categories/crafting.md` for the crafting
contracts.

A browser-native JavaScript mechanics toolbox for static websites and Android WebView hosts. Node.js is used only for development tests. The package has no runtime dependencies, server requirement, or bundling requirement.

This is working code, not the A25 Mechanics Library research archive.

## Test

```sh
npm test
```

## Import

```js
import { createCommand, createSeededRng } from './src/index.js';

const rng = createSeededRng(42);
const command = createCommand({
  commandId: 'cmd-000001',
  type: 'resource.gather',
  actorId: 'actor-1',
  roomId: 'wild',
  issuedAt: 0,
  payload: { itemId: 'wood' },
  expectedRevision: 0,
});
```

## State engine

The Batch 2 state engine provides an in-memory command registry, explicit actor permissions,
an append-only event store, and atomic command dispatch. IDs and timestamps are always
injected so runs remain deterministic.

```js
import {
  accept,
  createEngine,
  createEventStore,
  createIdFactory,
  createPermissionPolicy,
  createRegistry,
} from './src/index.js';

const registry = createRegistry();
registry.register('counter.increment', {
  decide(_state, command, context) {
    return accept([context.createEvent('counter.incremented', command.payload)]);
  },
  reduce(state, event) {
    return { count: state.count + event.payload.amount };
  },
});

const engine = createEngine({
  initialState: { count: 0 },
  registry,
  eventStore: createEventStore(),
  permissionPolicy: createPermissionPolicy({ player: ['counter.increment'] }),
  idFactory: createIdFactory('evt', 0),
  clock: () => 1000,
});
```

See `docs/contracts/dispatch.md` for dispatch ordering, result contracts, and atomicity rules.

## Inventory

Batch 3 adds immutable-style inventory operations, stack limits, durability and breakage,
atomic transfers, and exact-stack reservations. Register `createInventoryHandlers()` with
the Batch 2 engine to dispatch neutral `inventory.*` commands with injected stack IDs.

```js
import { addItem, createIdFactory } from './src/index.js';

const nextState = addItem(state, {
  containerId: 'bag', itemId: definition.itemId, quantity: 2,
  quality: null, durability: null, metadata: {}, definition,
  nextStackId: createIdFactory('stack', 0),
});
```

See `docs/categories/inventory.md` for the state, stacking, reservation, handler, and
durability contracts. Run `node examples/headless/inventory-transfer.mjs` for a complete
headless engine example.

## Crafting

Batch 5 adds immutable recipe validation, deterministic exact and substitution matching,
tool and station requirements, atomic input/station reservation, a four-state production
lifecycle, and replay-safe `craft.*` handlers. Quality uses explicit skill, difficulty,
condition, input-quality, and roll values; crafting never reads ambient randomness.

```js
import { calculateQuality, validateRecipe } from './src/index.js';

const quality = calculateQuality({
  skill: 60, difficulty: 40, toolCondition: 80, inputQuality: 65, roll: 0.5,
});
```

See `docs/categories/crafting.md` for recipe schemas, state shape, lifecycle rules, quality
formula, and handler options.

## Markets

Batch 6 adds funded buy orders, seller-owned stalls, deterministic basis-point pricing,
partial fulfillment, conserved accounting, and explicit Farmer/Beast Master routing.
Market mutations validate and clone before change, so rejected work leaves no partial state.

```js
import { placeBuyOrder, routeStalls } from './src/index.js';

market = placeBuyOrder(market, {
  orderId: 'order-1', buyerId: 'buyer', itemId: 'carrot', category: 'produce',
  quantity: 5, limitUnitPrice: 20, createdSequence: 1,
});
const routes = routeStalls(market, 'order-1');
```

See `docs/categories/markets.md` and run `node examples/headless/market-day.mjs`.

## Agents and routines

Batch 7 adds deterministic needs, skills, roles, bounded memory, recurring routines,
integer utility scoring, goal interruption/resumption, engine handlers, and bounded offline
decisions. Player and NPC actors use the same command vocabulary and permission boundary.

Stall-worker data groups crafting and market command proposals for indexing and selection;
it does not directly connect or mutate those independent systems. Selected gameplay commands
still require a separate `engine.dispatch(command)` call.

See `docs/categories/agents-and-routines.md` and run
`node examples/headless/stall-worker-day.mjs`.
