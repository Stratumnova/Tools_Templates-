import test from 'node:test';
import assert from 'node:assert/strict';

import { validateRoleSet, validateSkillProfile } from '../../src/agents/skills.js';
import { createAgentMemory, rememberObservation } from '../../src/agents/memory.js';

function observation(overrides = {}) {
  return {
    memoryId: 'memory.one',
    kind: 'market.stock_seen',
    subjectId: 'stall.one',
    sequence: 10,
    salience: 5,
    data: { itemId: 'food.apple', quantity: 2 },
    ...overrides,
  };
}

test('validates safe integer skills and isolates caller data', () => {
  const source = { farming: 4, 'market.trade': 9 };
  const profile = validateSkillProfile(source);
  source.farming = 99;

  assert.deepEqual(profile, { farming: 4, 'market.trade': 9 });
  assert.ok(Object.isFrozen(profile));
  assert.throws(() => validateSkillProfile({ farming: -1 }), TypeError);
  assert.throws(() => validateSkillProfile({ farming: Number.MAX_SAFE_INTEGER + 1 }), TypeError);
  assert.throws(() => validateSkillProfile({ 'not valid': 1 }), TypeError);
});

test('validates dense unique role identifiers and isolates caller arrays', () => {
  const source = ['role.farmer', 'role.stall_worker'];
  const roles = validateRoleSet(source);
  source[0] = 'role.changed';

  assert.deepEqual(roles, ['role.farmer', 'role.stall_worker']);
  assert.ok(Object.isFrozen(roles));
  assert.throws(() => validateRoleSet(['role.farmer', 'role.farmer']), TypeError);
  assert.throws(() => validateRoleSet(new Array(1)), TypeError);
  assert.throws(() => validateRoleSet(['bad role']), TypeError);
});

test('bounded memory rejects duplicate IDs and isolates observations', () => {
  const source = observation();
  const memory = rememberObservation(createAgentMemory(2), source);
  source.data.quantity = 500;

  assert.equal(memory.capacity, 2);
  assert.equal(memory.observations[0].data.quantity, 2);
  assert.ok(Object.isFrozen(memory));
  assert.ok(Object.isFrozen(memory.observations[0].data));
  assert.throws(() => rememberObservation(memory, observation()), TypeError);
});

test('evicts deterministically by salience sequence and memory ID', () => {
  let memory = createAgentMemory(3);
  memory = rememberObservation(memory, observation({ memoryId: 'memory.z', sequence: 1, salience: 2 }));
  memory = rememberObservation(memory, observation({ memoryId: 'memory.b', sequence: 3, salience: 1 }));
  memory = rememberObservation(memory, observation({ memoryId: 'memory.a', sequence: 3, salience: 1 }));
  memory = rememberObservation(memory, observation({ memoryId: 'memory.keep', sequence: 4, salience: 9 }));

  assert.deepEqual(memory.observations.map((entry) => entry.memoryId), [
    'memory.z',
    'memory.b',
    'memory.keep',
  ]);
});

test('rejects invalid capacity and hostile values without executing accessors', () => {
  assert.throws(() => createAgentMemory(0), TypeError);
  assert.throws(() => createAgentMemory(1001), TypeError);
  assert.throws(() => createAgentMemory(1.5), TypeError);

  let getterReads = 0;
  const accessor = observation();
  Object.defineProperty(accessor, 'salience', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 5;
    },
  });
  assert.throws(() => rememberObservation(createAgentMemory(2), accessor), TypeError);
  assert.equal(getterReads, 0);

  const cyclic = observation();
  cyclic.data.self = cyclic.data;
  assert.throws(() => rememberObservation(createAgentMemory(2), cyclic), TypeError);

  const symbol = observation();
  symbol.data[Symbol('hostile')] = true;
  assert.throws(() => rememberObservation(createAgentMemory(2), symbol), TypeError);

  const inherited = Object.create({ inherited: true });
  Object.assign(inherited, observation());
  assert.throws(() => rememberObservation(createAgentMemory(2), inherited), TypeError);

  assert.throws(
    () => rememberObservation(createAgentMemory(2), observation({ sequence: Number.MAX_SAFE_INTEGER + 1 })),
    TypeError,
  );
});
