# A25 Mechanics Toolbox

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
