import {
  createCommand,
  createEngine,
  createEventStore,
  createIdFactory,
  createInventoryHandlers,
  createPermissionPolicy,
  createRegistry,
} from '../../src/index.js';

const unit = {
  itemId: 'resource.unit', schemaVersion: '1.0.0', label: 'Resource Unit',
  tags: ['resource'], stackLimit: 20, durability: { enabled: false },
};
const initialState = {
  containersById: {
    source: { containerId: 'source', capacity: 20, stacks: [
      { stackId: 'source-stack', itemId: unit.itemId, quantity: 8, quality: null, durability: null, metadata: {} },
    ] },
    destination: { containerId: 'destination', capacity: 20, stacks: [] },
  },
  reservationsById: {},
};

const registry = createRegistry();
const handlers = createInventoryHandlers({
  definitionsById: { [unit.itemId]: unit },
  nextStackId: createIdFactory('stack', 0),
});
for (const [commandType, handler] of Object.entries(handlers)) registry.register(commandType, handler);

const engine = createEngine({
  initialState,
  registry,
  eventStore: createEventStore(),
  permissionPolicy: createPermissionPolicy({ example: ['inventory.transfer'] }),
  idFactory: createIdFactory('evt', 0),
  clock: () => 1000,
});

const result = engine.dispatch(createCommand({
  commandId: 'cmd-transfer', type: 'inventory.transfer', actorId: 'example', roomId: 'headless',
  issuedAt: 1000, expectedRevision: 0,
  payload: {
    sourceContainerId: 'source', targetContainerId: 'destination',
    itemId: unit.itemId, quantity: 3,
  },
}));
if (!result.accepted) throw new Error(`${result.rejection.code}: ${result.rejection.message}`);

const state = engine.getState();
const quantity = id => state.containersById[id].stacks.reduce((sum, stack) => sum + stack.quantity, 0);
console.log(`source=${quantity('source')} destination=${quantity('destination')} revision=${engine.getRevision()}`);
