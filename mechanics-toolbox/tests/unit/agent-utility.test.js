import test from 'node:test';
import assert from 'node:assert/strict';

import { rankCandidates, scoreCandidate } from '../../src/agents/utility.js';

const weights = Object.freeze({
  needPressure: 2,
  routinePriority: 3,
  skillFit: 4,
  memoryEvidence: 5,
  taskUrgency: 6,
  switchingCost: 7,
  modifiers: 1,
});

function candidate(overrides = {}) {
  return {
    candidateId: 'candidate.work',
    priority: 8,
    needPressure: 10,
    routinePriority: 8,
    skillFit: 3,
    memoryEvidence: 2,
    taskUrgency: 4,
    switchingCost: 2,
    modifiers: -3,
    ...overrides,
  };
}

test('returns exact weighted component facts and total', () => {
  const score = scoreCandidate(candidate(), weights);
  assert.deepEqual(score, {
    candidateId: 'candidate.work',
    priority: 8,
    components: {
      needPressure: 20,
      routinePriority: 24,
      skillFit: 12,
      memoryEvidence: 10,
      taskUrgency: 24,
      switchingCost: -14,
      modifiers: -3,
    },
    total: 73,
  });
  assert.ok(Object.isFrozen(score));
  assert.ok(Object.isFrozen(score.components));
});

test('ranks by total then priority then candidate ID', () => {
  const ranked = rankCandidates([
    candidate({ candidateId: 'candidate.z', priority: 3, modifiers: 0 }),
    candidate({ candidateId: 'candidate.b', priority: 8, modifiers: 0 }),
    candidate({ candidateId: 'candidate.a', priority: 8, modifiers: 0 }),
    candidate({ candidateId: 'candidate.high', priority: 1, modifiers: 10 }),
  ], weights);
  assert.deepEqual(ranked.map((entry) => entry.candidateId), [
    'candidate.high',
    'candidate.a',
    'candidate.b',
    'candidate.z',
  ]);
});

test('rejects multiplication and summation overflow', () => {
  assert.throws(
    () => scoreCandidate(candidate({ needPressure: Number.MAX_SAFE_INTEGER }), weights),
    TypeError,
  );
  assert.throws(
    () => scoreCandidate(candidate({
      needPressure: Number.MAX_SAFE_INTEGER,
      routinePriority: 1,
    }), { ...weights, needPressure: 1, routinePriority: 1 }),
    TypeError,
  );
});

test('rejects duplicate IDs and hostile or unsafe scoring data', () => {
  assert.throws(() => rankCandidates([candidate(), candidate()], weights), TypeError);
  assert.throws(() => scoreCandidate(candidate({ priority: -1 }), weights), TypeError);
  assert.throws(() => scoreCandidate(candidate({ skillFit: 1.5 }), weights), TypeError);
  assert.throws(() => scoreCandidate(candidate(), { ...weights, skillFit: -1 }), TypeError);

  let reads = 0;
  const accessor = candidate();
  Object.defineProperty(accessor, 'needPressure', {
    enumerable: true,
    get() {
      reads += 1;
      return 1;
    },
  });
  assert.throws(() => scoreCandidate(accessor, weights), TypeError);
  assert.equal(reads, 0);

  const sparse = new Array(1);
  assert.throws(() => rankCandidates(sparse, weights), TypeError);
  const cyclic = candidate();
  cyclic.loop = cyclic;
  assert.throws(() => scoreCandidate(cyclic, weights), TypeError);
});
