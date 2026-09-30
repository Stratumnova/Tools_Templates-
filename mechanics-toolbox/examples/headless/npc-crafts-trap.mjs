import {
  createCommand,
  createCraftingHandlers,
  createEngine,
  createEventStore,
  createIdFactory,
  createPermissionPolicy,
  createRegistry,
} from '../../src/index.js';

const simple = (itemId, label, tags = ['material'], stackLimit = 20) => ({
  itemId, schemaVersion: '1.0.0', label, tags, stackLimit, durability: { enabled: false },
});
const definitionsById = {
  'material.wood': simple('material.wood', 'Wood'),
  'material.rope': simple('material.rope', 'Rope'),
  'material.vine': simple('material.vine', 'Vine'),
  'material.scrap': simple('material.scrap', 'Scrap'),
  'item.trap': simple('item.trap', 'Trap', ['crafted'], 10),
  'tool.utility': {
    itemId: 'tool.utility', schemaVersion: '1.0.0', label: 'Utility Tool', tags: ['tool'],
    stackLimit: 1, durability: { enabled: true, max: 100, breakPolicy: 'remove' },
  },
};
const recipe = {
  recipeId: 'craft.trap', schemaVersion: '1.0.0',
  inputs: [{ itemId: 'material.wood', quantity: 2 }],
  substitutionGroups: [{ groupId: 'binding', quantity: 2, options: ['material.rope', 'material.vine'] }],
  tools: [{ itemId: 'tool.utility', minDurability: 10 }],
  stationTags: ['outdoors', 'workbench'], durationMs: 1000,
  outputs: [{ itemId: 'item.trap', quantity: 1 }],
  byproducts: [{ itemId: 'material.scrap', quantity: 1 }],
  skillId: 'skill.crafting', difficulty: 40,
};
const initialState = {
  containersById: {
    supplies: { containerId: 'supplies', capacity: 20, stacks: [
      { stackId: 'wood', itemId: 'material.wood', quantity: 2, quality: 60, durability: null, metadata: {} },
      { stackId: 'rope', itemId: 'material.rope', quantity: 2, quality: 60, durability: null, metadata: {} },
      { stackId: 'tool', itemId: 'tool.utility', quantity: 1, quality: null, durability: 80, metadata: {} },
    ] },
    finished: { containerId: 'finished', capacity: 10, stacks: [] },
  },
  reservationsById: {},
  taskReservationsById: {},
  craftJobsById: {},
  stationsById: { bench: { stationId: 'bench', tags: ['outdoors', 'workbench'] } },
};

const registry = createRegistry();
const handlers = createCraftingHandlers({
  recipesById: { [recipe.recipeId]: recipe }, definitionsById,
  nextCraftJobId: createIdFactory('craft-job', 0),
  nextReservationId: createIdFactory('reservation', 0),
  nextStackId: createIdFactory('stack', 0),
});
for (const [type, handler] of Object.entries(handlers)) registry.register(type, handler);
const engine = createEngine({
  initialState, registry, eventStore: createEventStore(),
  permissionPolicy: createPermissionPolicy({ 'npc.crafter': ['*'] }),
  idFactory: createIdFactory('event', 0), clock: () => 2000,
});
let commandId = 0;
const dispatch = (type, payload) => {
  commandId += 1;
  const result = engine.dispatch(createCommand({
    commandId: `command-${commandId}`, type, actorId: 'npc.crafter', roomId: 'workshop',
    issuedAt: 2000, expectedRevision: engine.getRevision(), payload,
  }));
  if (!result.accepted) throw new Error(`${result.rejection.code}: ${result.rejection.message}`);
};

dispatch('craft.queue', {
  recipeId: recipe.recipeId, sourceContainerId: 'supplies', outputContainerId: 'finished',
  stationId: 'bench', queuedAt: 1000, skill: 60, roll: 0.5,
});
dispatch('craft.start', { craftJobId: 'craft-job-000001', stationId: 'bench', startedAt: 1000 });
dispatch('craft.complete', { craftJobId: 'craft-job-000001', stationId: 'bench', completedAt: 2000 });

const state = engine.getState();
const job = state.craftJobsById['craft-job-000001'];
const outputQuantity = state.containersById.finished.stacks
  .filter(stack => stack.itemId === 'item.trap')
  .reduce((sum, stack) => sum + stack.quantity, 0);
console.log(`job=${job.craftJobId} status=${job.status} output=${outputQuantity}`);
