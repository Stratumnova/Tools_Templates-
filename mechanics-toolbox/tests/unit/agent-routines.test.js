import test from 'node:test';
import assert from 'node:assert/strict';

import { eligibleRoutineCandidates, validateRoutineDefinition } from '../../src/agents/routines.js';

function routine(overrides = {}) {
  return {
    routineId: 'routine.stock',
    enabled: true,
    period: 100,
    startOffset: 20,
    duration: 30,
    priority: 5,
    requiredRoleIds: ['role.stall_worker'],
    commandTemplate: { type: 'production.queue', payload: { recipeId: 'recipe.food' } },
    ...overrides,
  };
}

test('uses inclusive start and exclusive end boundaries', () => {
  const definitions = [routine()];
  const context = { roleIds: ['role.stall_worker'] };

  assert.equal(eligibleRoutineCandidates(definitions, 19, context).length, 0);
  assert.equal(eligibleRoutineCandidates(definitions, 20, context).length, 1);
  assert.equal(eligibleRoutineCandidates(definitions, 49, context).length, 1);
  assert.equal(eligibleRoutineCandidates(definitions, 50, context).length, 0);
  assert.equal(eligibleRoutineCandidates(definitions, 120, context).length, 1);
});

test('rejects wrapping windows and honors required roles and disabled routines', () => {
  assert.throws(() => validateRoutineDefinition(routine({ startOffset: 80, duration: 21 })), TypeError);
  assert.equal(eligibleRoutineCandidates([routine()], 25, { roleIds: [] }).length, 0);
  assert.equal(eligibleRoutineCandidates([routine({ enabled: false })], 25, {
    roleIds: ['role.stall_worker'],
  }).length, 0);
});

test('returns isolated candidates in stable routine ID order', () => {
  const later = routine({ routineId: 'routine.z', commandTemplate: { type: 'task.start', payload: {} } });
  const earlier = routine({ routineId: 'routine.a', priority: 8 });
  const candidates = eligibleRoutineCandidates(
    [later, earlier],
    25,
    { roleIds: ['role.stall_worker'] },
  );
  earlier.commandTemplate.payload.recipeId = 'recipe.changed';

  assert.deepEqual(candidates.map((entry) => entry.candidateId), ['routine.a', 'routine.z']);
  assert.deepEqual(candidates[0], {
    candidateId: 'routine.a',
    routineId: 'routine.a',
    priority: 8,
    windowStart: 20,
    windowEnd: 50,
    commandTemplate: { type: 'production.queue', payload: { recipeId: 'recipe.food' } },
  });
  assert.ok(Object.isFrozen(candidates[0].commandTemplate));
});

test('handles huge safe sequences without overflow', () => {
  const sequence = Number.MAX_SAFE_INTEGER - 10;
  const phase = sequence % 7;
  const result = eligibleRoutineCandidates([
    routine({ period: 7, startOffset: phase, duration: 1 }),
  ], sequence, { roleIds: ['role.stall_worker'] });
  assert.equal(result.length, 1);
});

test('rejects malformed and hostile routine data without getter execution', () => {
  assert.throws(() => validateRoutineDefinition(routine({ period: 0 })), TypeError);
  assert.throws(() => validateRoutineDefinition(routine({ requiredRoleIds: ['role.x', 'role.x'] })), TypeError);
  assert.throws(() => eligibleRoutineCandidates([routine()], -1, { roleIds: [] }), TypeError);

  let reads = 0;
  const accessor = routine();
  Object.defineProperty(accessor, 'priority', {
    enumerable: true,
    get() {
      reads += 1;
      return 5;
    },
  });
  assert.throws(() => validateRoutineDefinition(accessor), TypeError);
  assert.equal(reads, 0);

  const sparse = new Array(1);
  assert.throws(() => eligibleRoutineCandidates(sparse, 0, { roleIds: [] }), TypeError);

  const cyclic = routine();
  cyclic.commandTemplate.payload.self = cyclic.commandTemplate.payload;
  assert.throws(() => validateRoutineDefinition(cyclic), TypeError);

  const inherited = Object.create({ hidden: true });
  Object.assign(inherited, routine());
  assert.throws(() => validateRoutineDefinition(inherited), TypeError);
});
