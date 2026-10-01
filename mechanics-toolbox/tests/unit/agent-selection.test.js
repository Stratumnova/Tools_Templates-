import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentState, validateAgentState } from '../../src/agents/agents.js';
import { applyAgentDecisionFact, selectAgentDecision } from '../../src/agents/selection.js';
import { createAgentMemory } from '../../src/agents/memory.js';

function agent() {
  return createAgentState({
    agentId: 'agent.worker',
    actorId: 'actor.worker',
    needs: [],
    skills: { trading: 3 },
    roles: ['role.stall_worker'],
    memory: createAgentMemory(4),
  });
}

function ranked(candidateId, total, priority = 1) {
  return Object.freeze({
    candidateId,
    priority,
    components: Object.freeze({
      needPressure: total,
      routinePriority: 0,
      skillFit: 0,
      memoryEvidence: 0,
      taskUrgency: 0,
      switchingCost: 0,
      modifiers: 0,
    }),
    total,
  });
}

function decide(state, overrides = {}) {
  return selectAgentDecision({
    decisionId: `decision.${state.decisionIds.length + 1}`,
    agent: state,
    sequence: state.lastSequence + 1,
    rankedCandidates: [],
    interruptMargin: 5,
    hardInterruption: false,
    reason: 'routine_tick',
    ...overrides,
  });
}

test('registers valid agent state and selects idle or start with resolved rankings', () => {
  const state = agent();
  assert.deepEqual(validateAgentState(state), state);
  assert.equal(decide(state).action, 'idle');

  const rankings = [ranked('candidate.stock', 20), ranked('candidate.clean', 10)];
  const fact = decide(state, { rankedCandidates: rankings });
  assert.equal(fact.action, 'start');
  assert.equal(fact.winner.candidateId, 'candidate.stock');
  assert.deepEqual(fact.rankedCandidates, rankings);
  assert.deepEqual(fact.rankedCandidates[0].components, rankings[0].components);

  const started = applyAgentDecisionFact(state, fact);
  assert.equal(started.currentGoal.candidateId, 'candidate.stock');
  assert.equal(started.currentGoal.status, 'active');
});

test('retains below margin and interrupts at margin or on hard interruption', () => {
  const started = applyAgentDecisionFact(agent(), decide(agent(), {
    rankedCandidates: [ranked('candidate.stock', 20)],
  }));

  assert.equal(decide(started, {
    rankedCandidates: [ranked('candidate.clean', 24), ranked('candidate.stock', 20)],
  }).action, 'retain');
  assert.equal(decide(started, {
    rankedCandidates: [ranked('candidate.clean', 25), ranked('candidate.stock', 20)],
  }).action, 'interrupt');
  assert.equal(decide(started, {
    rankedCandidates: [ranked('candidate.clean', 1), ranked('candidate.stock', 20)],
    hardInterruption: true,
  }).action, 'interrupt');
});

test('applies suspend resume and complete lifecycle with terminal protection', () => {
  let state = applyAgentDecisionFact(agent(), decide(agent(), {
    rankedCandidates: [ranked('candidate.stock', 20)],
  }));
  state = applyAgentDecisionFact(state, {
    ...decide(state),
    action: 'suspend',
    winner: null,
    previousGoal: state.currentGoal,
  });
  assert.equal(state.currentGoal, null);
  assert.equal(state.suspendedGoals[0].status, 'suspended');

  state = applyAgentDecisionFact(state, {
    ...decide(state, { rankedCandidates: [ranked('candidate.stock', 20)] }),
    action: 'resume',
    winner: ranked('candidate.stock', 20),
    previousGoal: null,
  });
  assert.equal(state.currentGoal.status, 'active');

  state = applyAgentDecisionFact(state, {
    ...decide(state),
    action: 'complete',
    winner: null,
    previousGoal: state.currentGoal,
  });
  assert.deepEqual(state.completedGoalIds, ['candidate.stock']);
  assert.throws(() => applyAgentDecisionFact(state, {
    ...decide(state, { rankedCandidates: [ranked('candidate.stock', 99)] }),
    action: 'start',
    winner: ranked('candidate.stock', 99),
  }), TypeError);
});

test('rejects duplicate decisions and stale sequences', () => {
  const initial = agent();
  const fact = decide(initial);
  const next = applyAgentDecisionFact(initial, fact);
  assert.throws(() => applyAgentDecisionFact(next, fact), TypeError);
  assert.throws(() => applyAgentDecisionFact(next, { ...decide(next), sequence: 0 }), TypeError);
});

test('replays recorded facts without rescoring changed candidates', () => {
  const initial = agent();
  const rankings = [ranked('candidate.stock', 20), ranked('candidate.clean', 10)];
  const fact = decide(initial, { rankedCandidates: rankings });
  const expected = applyAgentDecisionFact(initial, fact);

  rankings[0] = ranked('candidate.changed', 500);
  const replayed = applyAgentDecisionFact(initial, fact);
  assert.deepEqual(replayed, expected);
  assert.equal(replayed.currentGoal.candidateId, 'candidate.stock');
});

test('rejects hostile and malformed decision facts atomically', () => {
  const state = agent();
  let reads = 0;
  const fact = { ...decide(state) };
  Object.defineProperty(fact, 'action', {
    enumerable: true,
    get() {
      reads += 1;
      return 'idle';
    },
  });
  assert.throws(() => applyAgentDecisionFact(state, fact), TypeError);
  assert.equal(reads, 0);
  assert.equal(state.decisionIds.length, 0);
});
