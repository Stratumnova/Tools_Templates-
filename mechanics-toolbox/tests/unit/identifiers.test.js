import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addItem, createCommand, createEngine, createEventStore, createIdFactory,
  createInventoryHandlers, createPermissionPolicy, createRegistry, isStableIdentifier,
  requireStableIdentifier, reserveQuantity, validateItemDefinition,
} from '../../src/index.js';

test('stable identifiers accept separated segments and reject whitespace, controls, and empty segments', () => {
  for (const value of ['a', 'actor-1', 'task_type:v2', 'inventory.add', 'A25']) {
    assert.equal(isStableIdentifier(value), true);
    assert.equal(requireStableIdentifier(value, 'value'), value);
  }
  for (const value of ['', ' ', ' a', 'a ', 'a b', 'a\nb', '.a', 'a.', 'a..b', 'a__b', 'a/:b', 1, null]) {
    assert.equal(isStableIdentifier(value), false);
    assert.throws(() => requireStableIdentifier(value, 'value'), TypeError);
  }
});

test('prior public identifier boundaries share the stable grammar', () => {
  assert.throws(() => createCommand({
    commandId: 'bad id', type: 'inventory.add', actorId: 'actor', roomId: 'room',
    issuedAt: 0, payload: {}, expectedRevision: 0,
  }), TypeError);
  assert.throws(() => createIdFactory('bad prefix', 0), TypeError);
  assert.throws(() => createPermissionPolicy({ 'bad actor': ['inventory.add'] }), TypeError);
  assert.throws(() => createPermissionPolicy({ actor: ['bad capability'] }), TypeError);
  assert.throws(() => createRegistry().register('bad command', { decide() {}, reduce() {} }), TypeError);
  assert.throws(() => validateItemDefinition({
    itemId: 'bad item', schemaVersion: '1.0.0', label: 'Bad', tags: [], stackLimit: 1,
    durability: { enabled: false },
  }), { code: 'inventory.invalid_definition' });
});

test('plain-object maps treat inherited names as ordinary own IDs', () => {
  const definition = {
    itemId: 'toString', schemaVersion: '1.0.0', label: 'Safe', tags: [], stackLimit: 2,
    durability: { enabled: false },
  };
  const state = {
    containersById: {
      toString: { containerId: 'toString', capacity: 2, stacks: [] },
    },
    reservationsById: {},
  };
  const added = addItem(state, {
    containerId: 'toString', itemId: 'toString', quantity: 1, quality: null,
    durability: null, metadata: {}, definition, nextStackId: () => 'constructor',
  });
  const reserved = reserveQuantity(added, {
    reservationId: 'toString', containerId: 'toString', itemId: 'toString', quantity: 1,
  });
  assert.equal(Object.hasOwn(reserved.reservationsById, 'toString'), true);
  assert.equal(reserved.reservationsById.toString.reservationId, 'toString');
});

test('inventory engine treats an absent inherited container ID as missing data', () => {
  const registry = createRegistry();
  const handlers = createInventoryHandlers({ definitionsById: {}, nextStackId: () => 'unused' });
  registry.register('inventory.damage_durability', handlers['inventory.damage_durability']);
  const engine = createEngine({
    initialState: { containersById: {}, reservationsById: {} }, registry,
    eventStore: createEventStore(),
    permissionPolicy: createPermissionPolicy({ actor: ['inventory.damage_durability'] }),
    idFactory: createIdFactory('evt', 0), clock: () => 0,
  });
  const command = createCommand({
    commandId: 'cmd-1', type: 'inventory.damage_durability', actorId: 'actor', roomId: 'room',
    issuedAt: 0, expectedRevision: 0,
    payload: { containerId: 'toString', stackId: 'stack-1', amount: 1 },
  });

  let result;
  assert.doesNotThrow(() => { result = engine.dispatch(command); });
  assert.equal(result.accepted, false);
  assert.match(result.rejection.code, /^inventory\./);
  assert.deepEqual(engine.getState(), { containersById: {}, reservationsById: {} });
});
