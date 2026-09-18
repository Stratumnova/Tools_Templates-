import test from 'node:test';
import assert from 'node:assert/strict';

import {
  consumeReservation,
  releaseReservation,
  reserveQuantity,
  transferItem,
} from '../../src/index.js';

const definition = {
  itemId: 'resource.unit', schemaVersion: '1.0.0', label: 'Resource unit', tags: ['resource'],
  stackLimit: 10, durability: { enabled: false },
};

function state() {
  return {
    containersById: {
      source: { containerId: 'source', capacity: 20, stacks: [
        { stackId: 'a', itemId: definition.itemId, quantity: 3, quality: 'high', durability: null, metadata: { batch: 1 } },
        { stackId: 'b', itemId: definition.itemId, quantity: 4, quality: 'low', durability: null, metadata: { batch: 2 } },
      ] },
      target: { containerId: 'target', capacity: 20, stacks: [] },
    },
    reservationsById: {},
  };
}

test('reservations allocate exact stacks, prevent overbooking, and do not remove physical quantity', () => {
  const original = state();
  const reserved = reserveQuantity(original, {
    reservationId: 'r1', containerId: 'source', itemId: definition.itemId, quantity: 5,
  });
  assert.deepEqual(reserved.reservationsById.r1, {
    reservationId: 'r1', containerId: 'source', itemId: definition.itemId, quantity: 5,
    allocations: [
      { stackId: 'a', quantity: 3, quality: 'high', durability: null, metadata: { batch: 1 } },
      { stackId: 'b', quantity: 2, quality: 'low', durability: null, metadata: { batch: 2 } },
    ],
  });
  assert.deepEqual(reserved.containersById.source.stacks.map(s => s.quantity), [3, 4]);
  assert.throws(() => reserveQuantity(reserved, {
    reservationId: 'r2', containerId: 'source', itemId: definition.itemId, quantity: 3,
  }), { code: 'inventory.insufficient_available' });
  assert.throws(() => reserveQuantity(reserved, {
    reservationId: 'r1', containerId: 'source', itemId: definition.itemId, quantity: 1,
  }), { code: 'inventory.duplicate_reservation' });
  assert.deepEqual(original, state());
});

test('release restores availability and reservation IDs cannot be used twice', () => {
  const reserved = reserveQuantity(state(), {
    reservationId: 'r1', containerId: 'source', itemId: definition.itemId, quantity: 7,
  });
  const released = releaseReservation(reserved, 'r1');
  assert.deepEqual(released.reservationsById, {});
  assert.doesNotThrow(() => reserveQuantity(released, {
    reservationId: 'r2', containerId: 'source', itemId: definition.itemId, quantity: 7,
  }));
  assert.throws(() => releaseReservation(released, 'r1'), { code: 'inventory.reservation_not_found' });
});

test('consume removes exactly allocated stack units and deletes the reservation', () => {
  let reserved = reserveQuantity(state(), {
    reservationId: 'r1', containerId: 'source', itemId: definition.itemId, quantity: 4,
  });
  const consumed = consumeReservation(reserved, 'r1');
  assert.deepEqual(consumed.containersById.source.stacks, [
    { stackId: 'b', itemId: definition.itemId, quantity: 3, quality: 'low', durability: null, metadata: { batch: 2 } },
  ]);
  assert.deepEqual(consumed.reservationsById, {});
  assert.throws(() => consumeReservation(consumed, 'r1'), { code: 'inventory.reservation_not_found' });
});

test('consumption rejects changed or missing allocated stacks atomically', () => {
  const reserved = reserveQuantity(state(), {
    reservationId: 'r1', containerId: 'source', itemId: definition.itemId, quantity: 4,
  });
  const changed = structuredClone(reserved);
  changed.containersById.source.stacks[0].metadata.batch = 99;
  assert.throws(() => consumeReservation(changed, 'r1'), { code: 'inventory.invalid_state' });
  assert.equal(changed.containersById.source.stacks[0].quantity, 3);
  assert.ok(changed.reservationsById.r1);
});

test('reserved quantities cannot be transferred and then consumed a second time', () => {
  const reserved = reserveQuantity(state(), {
    reservationId: 'r1', containerId: 'source', itemId: definition.itemId, quantity: 6,
  });
  assert.throws(() => transferItem(reserved, {
    sourceContainerId: 'source', targetContainerId: 'target', itemId: definition.itemId,
    quantity: 2, definition, nextStackId: () => 'new',
  }), { code: 'inventory.insufficient_available' });
  const moved = transferItem(reserved, {
    sourceContainerId: 'source', targetContainerId: 'target', itemId: definition.itemId,
    quantity: 1, definition, nextStackId: () => 'new',
  });
  assert.equal(moved.containersById.target.stacks[0].quantity, 1);
  const consumed = consumeReservation(moved, 'r1');
  assert.equal(consumed.containersById.source.stacks.reduce((n, s) => n + s.quantity, 0), 0);
});

test('reservation public boundaries reject sparse arrays, accessors, cycles, and unsupported values', () => {
  for (const mutate of [
    value => { value.containersById.source.stacks = [, value.containersById.source.stacks[0]]; },
    value => { Object.defineProperty(value.reservationsById, 'bad', { enumerable: true, get: () => ({}) }); },
    value => { value.loop = value; },
    value => { value.extra = Symbol('bad'); },
  ]) {
    const original = state();
    mutate(original);
    assert.throws(() => reserveQuantity(original, {
      reservationId: 'r1', containerId: 'source', itemId: definition.itemId, quantity: 1,
    }), TypeError);
  }
});
