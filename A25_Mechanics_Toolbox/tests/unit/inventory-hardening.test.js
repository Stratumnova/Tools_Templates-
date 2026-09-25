import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accept,
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

const unit = {
  itemId: 'resource.unit', schemaVersion: '1.0.0', label: 'Unit', tags: ['resource'],
  stackLimit: 10, durability: { enabled: false },
};
const durable = {
  itemId: 'tool.unit', schemaVersion: '1.0.0', label: 'Tool', tags: ['tool'],
  stackLimit: 5, durability: { enabled: true, max: 3, breakPolicy: 'remove' },
};

const stack = (overrides = {}) => ({
  stackId: 'stack-a', itemId: unit.itemId, quantity: 3,
  quality: 'standard', durability: null, metadata: { batch: 1 }, ...overrides,
});

function baseState() {
  return {
    containersById: {
      source: { containerId: 'source', capacity: 20, stacks: [stack()] },
      target: { containerId: 'target', capacity: 20, stacks: [] },
    },
    reservationsById: {},
  };
}

function allocation(overrides = {}) {
  return {
    stackId: 'stack-a', quantity: 2, quality: 'standard', durability: null,
    metadata: { batch: 1 }, ...overrides,
  };
}

function reservation(overrides = {}) {
  return {
    reservationId: 'r1', containerId: 'source', itemId: unit.itemId,
    quantity: 2, allocations: [allocation()], ...overrides,
  };
}

function assertInvalidState(mutator) {
  const state = baseState();
  mutator(state);
  const before = structuredClone(state);
  assert.throws(
    () => removeItem(state, { containerId: 'source', itemId: unit.itemId, quantity: 1 }),
    { code: 'inventory.invalid_state' },
  );
  assert.deepEqual(state, before);
}

test('state validation rejects duplicate stack IDs globally before any operation', () => {
  assertInvalidState(state => { state.containersById.source.stacks.push(stack({ quantity: 1 })); });
  assertInvalidState(state => { state.containersById.target.stacks.push(stack({ quantity: 1 })); });
});

test('state validation rejects container and capacity invariant violations', () => {
  assertInvalidState(state => { state.containersById.source.containerId = 'wrong'; });
  assertInvalidState(state => { state.containersById.source.capacity = 2; });
});

test('state validation rejects malformed reservation records and exact allocations', () => {
  const mutations = [
    state => { state.reservationsById.wrong = reservation(); },
    state => { state.reservationsById.r1 = reservation({ containerId: 'missing' }); },
    state => { state.reservationsById.r1 = reservation({ itemId: 'other.item' }); },
    state => { state.reservationsById.r1 = reservation({ quantity: 1 }); },
    state => { state.reservationsById.r1 = reservation({ allocations: [allocation(), allocation({ quantity: 1 })], quantity: 3 }); },
    state => { state.reservationsById.r1 = reservation({ allocations: [allocation({ stackId: 'missing' })] }); },
    state => { state.reservationsById.r1 = reservation({ allocations: [allocation({ quantity: 4 })], quantity: 4 }); },
    state => { state.reservationsById.r1 = reservation({ allocations: [allocation({ quality: 'changed' })] }); },
    state => { state.reservationsById.r1 = reservation({ allocations: [allocation({ metadata: { batch: 2 } })] }); },
  ];
  for (const mutate of mutations) assertInvalidState(mutate);
});

test('state validation rejects aggregate reservations beyond physical stack quantity', () => {
  assertInvalidState(state => {
    state.reservationsById.r1 = reservation({ quantity: 2 });
    state.reservationsById.r2 = reservation({
      reservationId: 'r2', quantity: 2, allocations: [allocation({ quantity: 2 })],
    });
  });
});

test('metadata object key insertion order does not prevent stacking and __proto__ stays safe', () => {
  const firstMetadata = JSON.parse('{"alpha":1,"__proto__":{"safe":true},"omega":{"x":2,"y":3}}');
  const secondMetadata = JSON.parse('{"omega":{"y":3,"x":2},"__proto__":{"safe":true},"alpha":1}');
  const state = {
    containersById: {
      bag: { containerId: 'bag', capacity: 10, stacks: [stack({ metadata: firstMetadata })] },
    }, reservationsById: {},
  };
  let generated = false;
  const result = addItem(state, {
    containerId: 'bag', itemId: unit.itemId, quantity: 2, quality: 'standard', durability: null,
    metadata: secondMetadata, definition: unit, nextStackId: () => { generated = true; return 'new'; },
  });
  assert.equal(generated, false);
  assert.equal(result.containersById.bag.stacks.length, 1);
  assert.equal(result.containersById.bag.stacks[0].quantity, 5);
  assert.equal(Object.hasOwn(result.containersById.bag.stacks[0].metadata, '__proto__'), true);
});

test('scrap references require fully valid definitions and reject reference cycles', () => {
  const parent = {
    ...durable,
    durability: { enabled: true, max: 3, breakPolicy: 'scrap', scrapItemId: 'material.scrap' },
  };
  const invalidScrap = { itemId: 'material.scrap' };
  assert.throws(
    () => validateItemDefinition(parent, { definitionsById: { 'material.scrap': invalidScrap } }),
    { code: 'inventory.invalid_definition' },
  );

  const a = { ...parent, itemId: 'item.a', durability: { ...parent.durability, scrapItemId: 'item.b' } };
  const b = { ...parent, itemId: 'item.b', durability: { ...parent.durability, scrapItemId: 'item.a' } };
  assert.throws(
    () => validateItemDefinition(a, { definitionsById: { 'item.a': a, 'item.b': b } }),
    { code: 'inventory.invalid_definition' },
  );
});

function makeEngine(initialState, definitionsById, nextStackId = createIdFactory('stack', 0)) {
  const registry = createRegistry();
  const handlers = createInventoryHandlers({ definitionsById, nextStackId });
  for (const [type, handler] of Object.entries(handlers)) registry.register(type, handler);
  return {
    handlers,
    engine: createEngine({
      initialState, registry, eventStore: createEventStore(),
      permissionPolicy: createPermissionPolicy({ actor: ['*'] }),
      idFactory: createIdFactory('evt', 0), clock: () => 500,
    }),
  };
}

function command(type, payload) {
  return createCommand({
    commandId: `cmd-${type}`, type, actorId: 'actor', roomId: 'room',
    issuedAt: 400, expectedRevision: 0, payload,
  });
}

function assertDispatchReplay({ initialState, definitionsById, type, payload, expectedType, expectedPayload }) {
  const { engine, handlers } = makeEngine(initialState, definitionsById);
  const result = engine.dispatch(command(type, payload));
  assert.equal(result.accepted, true);
  assert.deepEqual(result.events[0], {
    eventId: 'evt-000001', type: expectedType, commandId: `cmd-${type}`,
    actorId: 'actor', roomId: 'room', occurredAt: 500,
    payload: expectedPayload, schemaVersion: '1.0.0',
  });
  assert.deepEqual(handlers[type].reduce(initialState, result.events[0]), engine.getState());
  return engine.getState();
}

test('transfer and durability handlers emit exact replayable events', () => {
  const transferred = assertDispatchReplay({
    initialState: baseState(), definitionsById: { [unit.itemId]: unit },
    type: 'inventory.transfer',
    payload: { sourceContainerId: 'source', targetContainerId: 'target', itemId: unit.itemId, quantity: 2 },
    expectedType: 'inventory.item_transferred',
    expectedPayload: {
      sourceContainerId: 'source', targetContainerId: 'target', itemId: unit.itemId,
      quantity: 2, stackIds: ['stack-000001'],
    },
  });
  assert.equal(transferred.containersById.source.stacks[0].quantity, 1);
  assert.equal(transferred.containersById.target.stacks[0].quantity, 2);

  const damageState = {
    containersById: { bag: { containerId: 'bag', capacity: 10, stacks: [
      { stackId: 'tool-stack', itemId: durable.itemId, quantity: 2, quality: null, durability: 1, metadata: {} },
    ] } }, reservationsById: {},
  };
  const damaged = assertDispatchReplay({
    initialState: damageState, definitionsById: { [durable.itemId]: durable },
    type: 'inventory.damage_durability', payload: { containerId: 'bag', stackId: 'tool-stack', amount: 1 },
    expectedType: 'inventory.item_broken',
    expectedPayload: {
      containerId: 'bag', stackId: 'tool-stack', amount: 1,
      itemId: durable.itemId, quantity: 2, stackIds: [],
    },
  });
  assert.deepEqual(damaged.containersById.bag.stacks, []);
});

test('reservation handlers emit chosen allocations and replay reserve, release, and consume exactly', () => {
  const expectedAllocation = allocation();
  const reserved = assertDispatchReplay({
    initialState: baseState(), definitionsById: { [unit.itemId]: unit },
    type: 'inventory.reserve',
    payload: { reservationId: 'r1', containerId: 'source', itemId: unit.itemId, quantity: 2 },
    expectedType: 'inventory.quantity_reserved',
    expectedPayload: {
      reservationId: 'r1', containerId: 'source', itemId: unit.itemId, quantity: 2,
      allocations: [expectedAllocation],
    },
  });
  assert.deepEqual(reserved.reservationsById.r1.allocations, [expectedAllocation]);

  const released = assertDispatchReplay({
    initialState: reserved, definitionsById: { [unit.itemId]: unit },
    type: 'inventory.release_reservation', payload: { reservationId: 'r1' },
    expectedType: 'inventory.reservation_released', expectedPayload: { reservationId: 'r1' },
  });
  assert.deepEqual(released.reservationsById, {});

  const consumed = assertDispatchReplay({
    initialState: reserved, definitionsById: { [unit.itemId]: unit },
    type: 'inventory.consume_reservation', payload: { reservationId: 'r1' },
    expectedType: 'inventory.reservation_consumed', expectedPayload: {
      reservationId: 'r1', containerId: 'source', itemId: unit.itemId,
      quantity: 2, allocations: [expectedAllocation],
    },
  });
  assert.equal(consumed.containersById.source.stacks[0].quantity, 1);
  assert.deepEqual(consumed.reservationsById, {});
});

test('the real engine rejects a manually forged inventory event', () => {
  const inventory = createInventoryHandlers({
    definitionsById: { [unit.itemId]: unit }, nextStackId: createIdFactory('stack', 0),
  });
  const registry = createRegistry();
  registry.register('inventory.transfer', {
    decide() {
      return accept([{
        eventId: 'forged', type: 'inventory.item_transferred', commandId: 'cmd-inventory.transfer',
        actorId: 'actor', roomId: 'room', occurredAt: 500, schemaVersion: '1.0.0',
        payload: { sourceContainerId: 'source', targetContainerId: 'target', itemId: unit.itemId, quantity: 1, stackIds: ['x'] },
      }]);
    },
    reduce: inventory['inventory.transfer'].reduce,
  });
  const engine = createEngine({
    initialState: baseState(), registry, eventStore: createEventStore(),
    permissionPolicy: createPermissionPolicy({ actor: ['*'] }),
    idFactory: createIdFactory('evt', 0), clock: () => 500,
  });
  const result = engine.dispatch(command('inventory.transfer', {
    sourceContainerId: 'source', targetContainerId: 'target', itemId: unit.itemId, quantity: 1,
  }));
  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, 'INVALID_EVENT');
  assert.deepEqual(engine.getState(), baseState());
});

const terminalScrap = {
  itemId: 'material.terminal-scrap', schemaVersion: '1.0.0', label: 'Terminal Scrap',
  tags: ['material'], stackLimit: 20, durability: { enabled: false },
};
const scrapTool = {
  ...durable, itemId: 'tool.scrapping',
  durability: { enabled: true, max: 3, breakPolicy: 'scrap', scrapItemId: terminalScrap.itemId },
};

function brokenToolState(quantity = 2) {
  return {
    containersById: { bag: { containerId: 'bag', capacity: 100, stacks: [
      { stackId: 'broken-tools', itemId: scrapTool.itemId, quantity, quality: 'used', durability: 1, metadata: { source: 'test' } },
    ] } }, reservationsById: {},
  };
}

test('terminal non-durable scrap replacement is identical directly and through engine replay', () => {
  const catalog = { [scrapTool.itemId]: scrapTool, [terminalScrap.itemId]: terminalScrap };
  const direct = damageDurability(brokenToolState(), {
    containerId: 'bag', stackId: 'broken-tools', amount: 1,
    definition: scrapTool, definitionsById: catalog, nextStackId: () => 'scrap-stack',
  });
  assert.deepEqual(direct.state.containersById.bag.stacks, [{
    stackId: 'scrap-stack', itemId: terminalScrap.itemId, quantity: 2,
    quality: null, durability: null, metadata: {},
  }]);
  assert.deepEqual(direct.event, {
    type: 'inventory.item_broken',
    payload: { containerId: 'bag', stackId: 'broken-tools', itemId: scrapTool.itemId, quantity: 2 },
  });

  const initial = brokenToolState();
  const { engine, handlers } = makeEngine(initial, catalog, () => 'scrap-stack');
  const result = engine.dispatch(command('inventory.damage_durability', {
    containerId: 'bag', stackId: 'broken-tools', amount: 1,
  }));
  assert.equal(result.accepted, true);
  assert.deepEqual(result.events[0].payload, {
    containerId: 'bag', stackId: 'broken-tools', amount: 1,
    itemId: scrapTool.itemId, quantity: 2, stackIds: ['scrap-stack'],
  });
  assert.deepEqual(handlers['inventory.damage_durability'].reduce(initial, result.events[0]), direct.state);
  assert.deepEqual(engine.getState(), direct.state);
});

test('scrap definitions reject chained and durable remove-policy targets', () => {
  const chainedTarget = {
    ...scrapTool, itemId: 'material.chained',
    durability: { enabled: true, max: 2, breakPolicy: 'scrap', scrapItemId: terminalScrap.itemId },
  };
  const chainedParent = {
    ...scrapTool, durability: { ...scrapTool.durability, scrapItemId: chainedTarget.itemId },
  };
  assert.throws(() => validateItemDefinition(chainedParent, { definitionsById: {
    [terminalScrap.itemId]: terminalScrap,
    [chainedTarget.itemId]: chainedTarget,
  } }), { code: 'inventory.invalid_definition' });

  const removeTarget = {
    ...durable, itemId: terminalScrap.itemId,
    durability: { enabled: true, max: 2, breakPolicy: 'remove' },
  };
  assert.throws(
    () => validateItemDefinition(scrapTool, { definitionsById: { [terminalScrap.itemId]: removeTarget } }),
    { code: 'inventory.invalid_definition' },
  );
});

test('runtime scrap validation agrees with full-catalog definition validation', () => {
  const chained = {
    ...scrapTool, itemId: terminalScrap.itemId,
    durability: { enabled: true, max: 2, breakPolicy: 'scrap', scrapItemId: 'material.final' },
  };
  const catalog = {
    [scrapTool.itemId]: scrapTool,
    [terminalScrap.itemId]: chained,
    'material.final': { ...terminalScrap, itemId: 'material.final' },
  };
  const state = brokenToolState();
  const input = {
    containerId: 'bag', stackId: 'broken-tools', amount: 1,
    definition: scrapTool, definitionsById: catalog, nextStackId: () => 'unused',
  };
  assert.throws(() => damageDurability(state, input), { code: 'inventory.invalid_definition' });
  assert.deepEqual(state, brokenToolState());
  assert.equal(input.stackId, 'broken-tools');
  assert.equal(input.definitionsById, catalog);
});

test('late generated-ID failure keeps multi-portion transfer caller state and input unchanged', () => {
  const source = baseState();
  source.containersById.source.stacks = [
    stack({ stackId: 'first', quantity: 1, quality: 'first' }),
    stack({ stackId: 'second', quantity: 1, quality: 'second' }),
  ];
  const before = structuredClone(source);
  let call = 0;
  const input = {
    sourceContainerId: 'source', targetContainerId: 'target', itemId: unit.itemId,
    quantity: 2, definition: unit, nextStackId: () => (++call === 1 ? 'created' : undefined),
  };
  assert.throws(() => transferItem(source, input), { code: 'inventory.invalid_input' });
  assert.deepEqual(source, before);
  assert.equal(input.quantity, 2);
  assert.equal(input.definition, unit);
});

test('invalid or exhausted later IDs keep multi-stack add caller state and input unchanged', () => {
  for (const invalidId of ['', undefined]) {
    const state = { containersById: { bag: { containerId: 'bag', capacity: 30, stacks: [] } }, reservationsById: {} };
    const before = structuredClone(state);
    let call = 0;
    const input = {
      containerId: 'bag', itemId: unit.itemId, quantity: 11, quality: null, durability: null,
      metadata: {}, definition: { ...unit, stackLimit: 5 },
      nextStackId: () => (++call === 1 ? 'first' : invalidId),
    };
    assert.throws(() => addItem(state, input), { code: 'inventory.invalid_input' });
    assert.deepEqual(state, before);
    assert.equal(input.quantity, 11);
    assert.deepEqual(input.metadata, {});
  }
});

test('late scrap replacement ID collision keeps caller state and input unchanged', () => {
  const state = brokenToolState(25);
  state.containersById.other = {
    containerId: 'other', capacity: 10,
    stacks: [{ stackId: 'existing', itemId: terminalScrap.itemId, quantity: 1, quality: null, durability: null, metadata: {} }],
  };
  const before = structuredClone(state);
  const catalog = { [scrapTool.itemId]: scrapTool, [terminalScrap.itemId]: terminalScrap };
  let call = 0;
  const input = {
    containerId: 'bag', stackId: 'broken-tools', amount: 1,
    definition: scrapTool, definitionsById: catalog,
    nextStackId: () => (++call === 1 ? 'first-scrap' : 'existing'),
  };
  assert.throws(() => damageDurability(state, input), { code: 'inventory.duplicate_stack' });
  assert.deepEqual(state, before);
  assert.equal(input.definition, scrapTool);
  assert.equal(input.definitionsById, catalog);
});
