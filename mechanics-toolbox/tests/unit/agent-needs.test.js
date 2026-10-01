import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceNeed,
  createNeedState,
  validateNeedDefinition,
} from '../../src/agents/needs.js';

function definition(overrides = {}) {
  return {
    needId: 'need.hunger',
    minimum: 0,
    maximum: 100,
    initial: 80,
    interval: 10,
    decayPerInterval: 7,
    weight: 3,
    urgencyPoints: [
      { value: 0, urgency: 100 },
      { value: 50, urgency: 40 },
      { value: 100, urgency: 0 },
    ],
    ...overrides,
  };
}

test('validates_and_isolates_need_definitions', () => {
  const source = definition();
  const validated = validateNeedDefinition(source);

  source.needId = 'need.changed';
  source.urgencyPoints[0].urgency = 0;

  assert.equal(validated.needId, 'need.hunger');
  assert.equal(validated.urgencyPoints[0].urgency, 100);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.urgencyPoints));
  assert.deepEqual(createNeedState(validated, 20), {
    needId: 'need.hunger',
    value: 80,
    lastSequence: 20,
    appliedIntervals: 0,
  });
});

test('advances_decay_by_complete_intervals', () => {
  const def = definition();
  const start = createNeedState(def, 5);

  assert.deepEqual(advanceNeed(start, def, 34), {
    needId: 'need.hunger',
    value: 66,
    lastSequence: 25,
    appliedIntervals: 2,
  });
  assert.deepEqual(advanceNeed(start, def, 14), start);
});

test('clamps_at_minimum', () => {
  const def = definition({ initial: 9, decayPerInterval: 7 });
  const result = advanceNeed(createNeedState(def, 0), def, 100);

  assert.deepEqual(result, {
    needId: 'need.hunger',
    value: 0,
    lastSequence: 100,
    appliedIntervals: 10,
  });
});

test('rejects_backward_time_and_overflow', () => {
  const def = definition();
  const state = createNeedState(def, 10);

  assert.throws(() => createNeedState(def, -1), TypeError);
  assert.throws(() => advanceNeed(state, def, 9), TypeError);
  assert.throws(
    () => advanceNeed(
      { needId: 'need.hunger', value: 80, lastSequence: 0, appliedIntervals: Number.MAX_SAFE_INTEGER },
      def,
      10,
    ),
    TypeError,
  );
  assert.throws(() => validateNeedDefinition(definition({ interval: Number.MAX_SAFE_INTEGER + 1 })), TypeError);
  assert.throws(() => validateNeedDefinition(definition({ minimum: 50, initial: 49 })), TypeError);
  const extreme = definition({
    minimum: -Number.MAX_SAFE_INTEGER,
    maximum: Number.MAX_SAFE_INTEGER,
    initial: -Number.MAX_SAFE_INTEGER,
    decayPerInterval: Number.MAX_SAFE_INTEGER,
    urgencyPoints: [
      { value: -Number.MAX_SAFE_INTEGER, urgency: 1 },
      { value: Number.MAX_SAFE_INTEGER, urgency: 0 },
    ],
  });
  assert.throws(() => advanceNeed(createNeedState(extreme, 0), extreme, 10), TypeError);
});

test('rejects_hostile_need_data_without_getter_execution', () => {
  let getterReads = 0;
  const accessor = definition();
  Object.defineProperty(accessor, 'weight', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 3;
    },
  });
  assert.throws(() => validateNeedDefinition(accessor), TypeError);
  assert.equal(getterReads, 0);

  const sparse = definition({ urgencyPoints: new Array(1) });
  assert.throws(() => validateNeedDefinition(sparse), TypeError);

  const cyclic = definition();
  cyclic.loop = cyclic;
  assert.throws(() => validateNeedDefinition(cyclic), TypeError);

  const inherited = Object.create({ hidden: true });
  Object.assign(inherited, definition());
  assert.throws(() => validateNeedDefinition(inherited), TypeError);

  const symbol = definition();
  symbol[Symbol('hostile')] = true;
  assert.throws(() => validateNeedDefinition(symbol), TypeError);
});
