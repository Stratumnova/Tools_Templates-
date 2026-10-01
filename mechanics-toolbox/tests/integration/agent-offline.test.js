import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentState } from '../../src/agents/agents.js';
import { createAgentMemory, rememberObservation } from '../../src/agents/memory.js';
import { advanceAgentsOffline } from '../../src/agents/offline.js';

function score(candidateId, total) {
  return {
    candidateId, priority: 1,
    components: {
      needPressure: total, routinePriority: 0, skillFit: 0, memoryEvidence: 0,
      taskUrgency: 0, switchingCost: 0, modifiers: 0,
    },
    total,
  };
}

function state() {
  let memory = createAgentMemory(4);
  memory = rememberObservation(memory, {
    memoryId: 'memory.stock', kind: 'market.stock_seen', subjectId: 'stall.one',
    sequence: 0, salience: 2, data: {},
  });
  return {
    agentsById: {
      'agent.worker': createAgentState({
        agentId: 'agent.worker', actorId: 'actor.worker', needs: [], skills: {},
        roles: ['role.stall_worker'], memory,
      }),
    },
    offlineAgentClaimsById: {},
  };
}

function input(overrides = {}) {
  return {
    intervalId: 'interval.one',
    fromSequence: 0,
    toSequence: 10,
    maxDecisions: 2,
    candidateFacts: [
      {
        agentId: 'agent.worker', sequence: 8, rankedCandidates: [score('candidate.clean', 30)],
        interruptMargin: 5, hardInterruption: false, reason: 'offline_tick',
      },
      {
        agentId: 'agent.worker', sequence: 2, rankedCandidates: [score('candidate.stock', 20)],
        interruptMargin: 5, hardInterruption: false, reason: 'offline_tick',
      },
      {
        agentId: 'agent.worker', sequence: 6, rankedCandidates: [score('candidate.wait', 1)],
        interruptMargin: 5, hardInterruption: false, reason: 'offline_tick',
      },
    ],
    decisionIds: ['decision.offline.1', 'decision.offline.2'],
    ...overrides,
  };
}

test('bounds decisions orders them chronologically and preserves interval boundaries', () => {
  const result = advanceAgentsOffline(state(), input());
  assert.deepEqual(result.facts.map((fact) => fact.sequence), [2, 6]);
  assert.deepEqual(result.facts.map((fact) => fact.decisionId), [
    'decision.offline.1', 'decision.offline.2',
  ]);
  assert.deepEqual(result.summary, {
    intervalId: 'interval.one', fromSequence: 0, toSequence: 10,
    considered: 3, applied: 2, truncated: 1,
  });
  assert.equal(result.state.agentsById['agent.worker'].currentGoal.candidateId, 'candidate.stock');
});

test('includes the end boundary excludes the start boundary and handles zero duration', () => {
  const boundary = advanceAgentsOffline(state(), input({
    maxDecisions: 2,
    candidateFacts: [
      { ...input().candidateFacts[0], sequence: 0 },
      { ...input().candidateFacts[0], sequence: 10 },
    ],
    decisionIds: ['decision.boundary.1', 'decision.boundary.2'],
  }));
  assert.deepEqual(boundary.facts.map((fact) => fact.sequence), [10]);

  const zero = advanceAgentsOffline(state(), input({
    intervalId: 'interval.zero', fromSequence: 5, toSequence: 5,
  }));
  assert.equal(zero.facts.length, 0);
  assert.equal(zero.summary.applied, 0);
});

test('duplicate interval replay returns stored facts without duplicate goals or memories', () => {
  const first = advanceAgentsOffline(state(), input());
  const second = advanceAgentsOffline(first.state, input({
    decisionIds: ['decision.changed.1', 'decision.changed.2'],
    candidateFacts: [],
  }));
  assert.deepEqual(second, first);
  assert.equal(second.state.agentsById['agent.worker'].memory.observations.length, 1);
  assert.equal(second.state.agentsById['agent.worker'].suspendedGoals.length, 0);
});

test('rejects stale and unsafe intervals without partial state', () => {
  const original = state();
  assert.throws(() => advanceAgentsOffline(original, input({ fromSequence: 11, toSequence: 10 })), TypeError);
  assert.throws(() => advanceAgentsOffline(original, input({
    fromSequence: 0, toSequence: Number.MAX_SAFE_INTEGER + 1,
    candidateFacts: [{ ...input().candidateFacts[0], sequence: Number.MAX_SAFE_INTEGER }],
  })), TypeError);

  const progressed = advanceAgentsOffline(original, input()).state;
  assert.throws(() => advanceAgentsOffline(progressed, input({
    intervalId: 'interval.stale', fromSequence: 0, toSequence: 20,
  })), TypeError);
  assert.equal(original.agentsById['agent.worker'].decisionIds.length, 0);
});
