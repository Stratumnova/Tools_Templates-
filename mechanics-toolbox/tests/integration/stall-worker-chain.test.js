import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentState } from '../../src/agents/agents.js';
import { createAgentMemory } from '../../src/agents/memory.js';
import { applyAgentDecisionFact, selectAgentDecision } from '../../src/agents/selection.js';
import { buildStallWorkerCandidates } from '../../src/agents/stall-worker.js';
import { rankCandidates } from '../../src/agents/utility.js';

const weights = {
  needPressure: 1, routinePriority: 1, skillFit: 1, memoryEvidence: 1,
  taskUrgency: 1, switchingCost: 1, modifiers: 1,
};

function context(overrides = {}) {
  return {
    agentId: 'agent.stall_worker',
    roleIds: ['role.stall_worker'],
    sequence: 20,
    lowStock: [
      {
        stallId: 'stall.food', itemId: 'food.stew', current: 1, target: 5,
        recipeId: 'recipe.stew', stationId: 'station.kitchen', priority: 8,
      },
    ],
    openOrders: [
      {
        orderId: 'order.stew', stallId: 'stall.food', tradeId: 'trade.stew.1',
        quantity: 2, priority: 10,
      },
    ],
    ...overrides,
  };
}

test('groups low-stock craft and fulfillment proposals without dispatching', () => {
  const source = context();
  const candidates = buildStallWorkerCandidates(source);
  source.lowStock[0].target = 500;

  assert.deepEqual(candidates.map((entry) => entry.candidateId), [
    'stall-worker.fulfill.order.stew',
    'stall-worker.produce.food.stew',
  ]);
  assert.deepEqual(candidates[0].commandTemplate, {
    type: 'market.buy_order_fulfill',
    payload: { orderId: 'order.stew', stallId: 'stall.food', tradeId: 'trade.stew.1', quantity: 2 },
  });
  assert.deepEqual(candidates[1].commandTemplate, {
    type: 'production.queue',
    payload: { recipeId: 'recipe.stew', stationId: 'station.kitchen' },
  });
  assert.ok(Object.isFrozen(candidates[0]));
});

test('role gating and stock threshold prevent unroutable work', () => {
  assert.deepEqual(buildStallWorkerCandidates(context({ roleIds: ['role.farmer'] })), []);
  assert.deepEqual(buildStallWorkerCandidates(context({
    lowStock: [{ ...context().lowStock[0], current: 5 }], openOrders: [],
  })), []);
});

test('ranked selection records facts and replay ignores changed source data', () => {
  const source = context();
  const candidates = buildStallWorkerCandidates(source);
  const ranked = rankCandidates(candidates, weights);
  const agent = createAgentState({
    agentId: 'agent.stall_worker', actorId: 'actor.worker', needs: [], skills: {},
    roles: ['role.stall_worker'], memory: createAgentMemory(4),
  });
  const fact = selectAgentDecision({
    decisionId: 'decision.stall.1', agent, sequence: 20, rankedCandidates: ranked,
    interruptMargin: 5, hardInterruption: false, reason: 'stall_worker_tick',
  });
  const expected = applyAgentDecisionFact(agent, fact);
  source.openOrders.length = 0;
  source.lowStock.length = 0;

  assert.deepEqual(applyAgentDecisionFact(agent, fact), expected);
  assert.equal(expected.currentGoal.candidateId, 'stall-worker.fulfill.order.stew');
  assert.throws(() => applyAgentDecisionFact(expected, fact), TypeError);
});

test('rejects hostile adapter data without executing accessors', () => {
  let reads = 0;
  const hostile = context();
  Object.defineProperty(hostile.lowStock[0], 'current', {
    enumerable: true,
    get() {
      reads += 1;
      return 1;
    },
  });
  assert.throws(() => buildStallWorkerCandidates(hostile), TypeError);
  assert.equal(reads, 0);

  const cyclic = context();
  cyclic.openOrders[0].self = cyclic.openOrders[0];
  assert.throws(() => buildStallWorkerCandidates(cyclic), TypeError);
  const sparse = context({ lowStock: new Array(1) });
  assert.throws(() => buildStallWorkerCandidates(sparse), TypeError);
});
