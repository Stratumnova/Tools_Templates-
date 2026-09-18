import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addItem,
  createCommand,
  createEngine,
  createEventStore,
  createIdFactory,
  createInventoryHandlers,
  createPermissionPolicy,
  createRegistry,
  damageDurability,
  removeItem,
  transferItem,
  validateItemDefinition,
} from '../../src/index.js';

const tool = {
  itemId: 'tool.hammer', schemaVersion: '1.0.0', label: 'Hammer',
  tags: ['tool'], stackLimit: 5,
  durability: { enabled: true, max: 10, breakPolicy: 'remove' },
};
const scrap = {
  itemId: 'material.scrap', schemaVersion: '1.0.0', label: 'Scrap',
  tags: ['material'], stackLimit: 20,
  durability: { enabled: false },
};
const recyclable = {
  ...tool, itemId: 'tool.recyclable', label: 'Recyclable tool',
  durability: { enabled: true, max: 4, breakPolicy: 'scrap', scrapItemId: 'material.scrap' },
};

const emptyState = (capacity = 20) => ({
  containersById: { bag: { containerId: 'bag', capacity, stacks: [] } },
  reservationsById: {},
});

function ids(...values) {
  let index = 0;
  return () => values[index++];
}

test('validateItemDefinition returns an isolated copy and rejects incoherent definitions', () => {
  const source = { ...recyclable, tags: [...recyclable.tags], durability: { ...recyclable.durability } };
  const validated = validateItemDefinition(source, { definitionsById: { 'material.scrap': scrap } });
  assert.deepEqual(validated, source);
  assert.notEqual(validated, source);
  source.tags.push('changed');
  source.durability.max = 99;
  assert.deepEqual(validated.tags, ['tool']);
  assert.equal(validated.durability.max, 4);
  assert.equal(Object.isFrozen(source), false);

  for (const invalid of [
    { ...tool, itemId: ' bad ' },
    { ...tool, schemaVersion: '' },
    { ...tool, label: ' ' },
    { ...tool, tags: ['tool', 'tool'] },
    { ...tool, tags: [''] },
    { ...tool, stackLimit: 0 },
    { ...tool, durability: { enabled: true, max: 0, breakPolicy: 'remove' } },
    { ...tool, durability: { enabled: true, max: 1, breakPolicy: 'scrap' } },
    { ...tool, durability: { enabled: false, breakPolicy: 'remove' } },
  ]) assert.throws(() => validateItemDefinition(invalid), { code: 'inventory.invalid_definition' });
  assert.throws(
    () => validateItemDefinition(recyclable, { definitionsById: {} }),
    { code: 'inventory.invalid_definition' },
  );
});

test('public boundaries reject hostile or unsupported nested values without touching callers', () => {
  const cycle = {}; cycle.self = cycle;
  const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
  const sparse = [, 'tool'];
  const protoPayload = JSON.parse('{"__proto__":{"safe":true}}');
  for (const metadata of [cycle, accessor, { sparse }, { value: undefined }]) {
    const state = emptyState();
    assert.throws(() => addItem(state, {
      containerId: 'bag', itemId: tool.itemId, quantity: 1, quality: 'standard',
      durability: 10, metadata, definition: tool, nextStackId: ids('stack-1'),
    }), TypeError);
    assert.deepEqual(state, emptyState());
  }
  const result = addItem(emptyState(), {
    containerId: 'bag', itemId: tool.itemId, quantity: 1, quality: 'standard',
    durability: 10, metadata: protoPayload, definition: tool, nextStackId: ids('stack-1'),
  });
  assert.equal(Object.hasOwn(result.containersById.bag.stacks[0].metadata, '__proto__'), true);
  assert.deepEqual(result.containersById.bag.stacks[0].metadata.__proto__, { safe: true });
});

test('add stacks compatible units, splits overflow deterministically, and preserves caller ownership', () => {
  const state = emptyState();
  const input = {
    containerId: 'bag', itemId: tool.itemId, quantity: 7, quality: 'fine', durability: 8,
    metadata: { maker: { id: 'smith' } }, definition: tool, nextStackId: ids('stack-a', 'stack-b'),
  };
  const added = addItem(state, input);
  assert.deepEqual(added.containersById.bag.stacks.map(({ stackId, quantity }) => ({ stackId, quantity })), [
    { stackId: 'stack-a', quantity: 5 }, { stackId: 'stack-b', quantity: 2 },
  ]);
  input.metadata.maker.id = 'changed';
  assert.equal(added.containersById.bag.stacks[0].metadata.maker.id, 'smith');
  assert.deepEqual(state, emptyState());
  assert.equal(Object.isFrozen(state), false);

  const topped = addItem(added, { ...input, quantity: 2, metadata: { maker: { id: 'smith' } }, nextStackId: ids() });
  assert.deepEqual(topped.containersById.bag.stacks.map(stack => stack.quantity), [5, 4]);
});

test('quality, durability, and structural metadata incompatibility create separate stacks', () => {
  let state = emptyState();
  const base = { containerId: 'bag', itemId: tool.itemId, quantity: 1, definition: tool };
  state = addItem(state, { ...base, quality: 'fine', durability: 8, metadata: { mark: 1 }, nextStackId: ids('a') });
  state = addItem(state, { ...base, quality: 'plain', durability: 8, metadata: { mark: 1 }, nextStackId: ids('b') });
  state = addItem(state, { ...base, quality: 'fine', durability: 7, metadata: { mark: 1 }, nextStackId: ids('c') });
  state = addItem(state, { ...base, quality: 'fine', durability: 8, metadata: { mark: 2 }, nextStackId: ids('d') });
  assert.deepEqual(state.containersById.bag.stacks.map(stack => stack.stackId), ['a', 'b', 'c', 'd']);
});

test('capacity rejection and failed remove leave input unchanged', () => {
  const state = emptyState(1);
  assert.throws(() => addItem(state, {
    containerId: 'bag', itemId: tool.itemId, quantity: 2, quality: null, durability: 10,
    metadata: {}, definition: tool, nextStackId: ids('unused'),
  }), { code: 'inventory.capacity_exceeded' });
  assert.throws(() => removeItem(state, { containerId: 'bag', itemId: tool.itemId, quantity: 1 }), {
    code: 'inventory.insufficient_quantity',
  });
  assert.deepEqual(state, emptyState(1));
});

test('remove spans stacks deterministically and transfer checks target capacity before source removal', () => {
  const source = {
    containersById: {
      source: { containerId: 'source', capacity: 10, stacks: [
        { stackId: 'a', itemId: tool.itemId, quantity: 2, quality: 'fine', durability: 9, metadata: {} },
        { stackId: 'b', itemId: tool.itemId, quantity: 3, quality: 'fine', durability: 9, metadata: {} },
      ] },
      target: { containerId: 'target', capacity: 1, stacks: [] },
    }, reservationsById: {},
  };
  const removed = removeItem(source, { containerId: 'source', itemId: tool.itemId, quantity: 4 });
  assert.deepEqual(removed.containersById.source.stacks.map(s => [s.stackId, s.quantity]), [['b', 1]]);

  assert.throws(() => transferItem(source, {
    sourceContainerId: 'source', targetContainerId: 'target', itemId: tool.itemId,
    quantity: 2, definition: tool, nextStackId: ids('never'),
  }), { code: 'inventory.capacity_exceeded' });
  assert.deepEqual(source.containersById.source.stacks.map(s => s.quantity), [2, 3]);
});

test('transfer preserves exact stack traits and uses deterministic target stack IDs', () => {
  const state = {
    containersById: {
      source: { containerId: 'source', capacity: 10, stacks: [
        { stackId: 'a', itemId: tool.itemId, quantity: 2, quality: 'fine', durability: 9, metadata: { mark: 1 } },
        { stackId: 'b', itemId: tool.itemId, quantity: 2, quality: 'plain', durability: 7, metadata: { mark: 2 } },
      ] },
      target: { containerId: 'target', capacity: 10, stacks: [] },
    }, reservationsById: {},
  };
  const moved = transferItem(state, {
    sourceContainerId: 'source', targetContainerId: 'target', itemId: tool.itemId,
    quantity: 3, definition: tool, nextStackId: ids('new-a', 'new-b'),
  });
  assert.deepEqual(moved.containersById.source.stacks.map(s => [s.stackId, s.quantity]), [['b', 1]]);
  assert.deepEqual(moved.containersById.target.stacks, [
    { stackId: 'new-a', itemId: tool.itemId, quantity: 2, quality: 'fine', durability: 9, metadata: { mark: 1 } },
    { stackId: 'new-b', itemId: tool.itemId, quantity: 1, quality: 'plain', durability: 7, metadata: { mark: 2 } },
  ]);
});

test('durability decrements, removes broken stacks, or replaces broken quantity with validated scrap', () => {
  const original = {
    containersById: { bag: { containerId: 'bag', capacity: 10, stacks: [
      { stackId: 'tools', itemId: tool.itemId, quantity: 2, quality: 'fine', durability: 2, metadata: {} },
    ] } }, reservationsById: {},
  };
  const damaged = damageDurability(original, { containerId: 'bag', stackId: 'tools', amount: 1, definition: tool });
  assert.equal(damaged.state.containersById.bag.stacks[0].durability, 1);
  assert.equal(damaged.event, null);

  const broken = damageDurability(original, { containerId: 'bag', stackId: 'tools', amount: 2, definition: tool });
  assert.deepEqual(broken.state.containersById.bag.stacks, []);
  assert.deepEqual(broken.event, {
    type: 'inventory.item_broken', payload: { containerId: 'bag', stackId: 'tools', itemId: tool.itemId, quantity: 2 },
  });

  const recycledState = structuredClone(original);
  recycledState.containersById.bag.stacks[0].itemId = recyclable.itemId;
  recycledState.containersById.bag.stacks[0].durability = 1;
  const recycled = damageDurability(recycledState, {
    containerId: 'bag', stackId: 'tools', amount: 1, definition: recyclable,
    definitionsById: { 'material.scrap': scrap }, nextStackId: ids('scrap-1'),
  });
  assert.deepEqual(recycled.state.containersById.bag.stacks, [
    { stackId: 'scrap-1', itemId: scrap.itemId, quantity: 2, quality: null, durability: null, metadata: {} },
  ]);
  assert.equal(recycled.event.type, 'inventory.item_broken');
  assert.deepEqual(original.containersById.bag.stacks[0], {
    stackId: 'tools', itemId: tool.itemId, quantity: 2, quality: 'fine', durability: 2, metadata: {},
  });
});

test('inventory handlers dispatch through the real engine with command-bound deterministic metadata', () => {
  const registry = createRegistry();
  const handlers = createInventoryHandlers({
    definitionsById: { [tool.itemId]: tool }, nextStackId: ids('stack-1'),
  });
  for (const [type, handler] of Object.entries(handlers)) registry.register(type, handler);
  const engine = createEngine({
    initialState: emptyState(), registry, eventStore: createEventStore(),
    permissionPolicy: createPermissionPolicy({ player: ['inventory.add'] }),
    idFactory: createIdFactory('evt', 0), clock: () => 123,
  });
  const result = engine.dispatch(createCommand({
    commandId: 'cmd-1', type: 'inventory.add', actorId: 'player', roomId: 'room', issuedAt: 100,
    payload: { containerId: 'bag', itemId: tool.itemId, quantity: 2, quality: 'fine', durability: 10, metadata: {} },
    expectedRevision: 0,
  }));
  assert.equal(result.accepted, true);
  assert.deepEqual(result.events[0], {
    eventId: 'evt-000001', type: 'inventory.item_added', commandId: 'cmd-1', actorId: 'player',
    roomId: 'room', occurredAt: 123, schemaVersion: '1.0.0',
    payload: { containerId: 'bag', itemId: tool.itemId, quantity: 2, quality: 'fine', durability: 10, metadata: {}, stackIds: ['stack-1'] },
  });
  assert.equal(engine.getState().containersById.bag.stacks[0].quantity, 2);
  assert.equal(engine.getRevision(), 1);
});
