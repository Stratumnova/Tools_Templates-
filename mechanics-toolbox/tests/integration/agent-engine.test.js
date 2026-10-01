import test from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../../src/core/engine.js';
import { createEventStore } from '../../src/core/event-store.js';
import { createIdFactory } from '../../src/core/ids.js';
import { createPermissionPolicy } from '../../src/core/permissions.js';
import { createRegistry } from '../../src/core/registry.js';
import { ERROR_CODES } from '../../src/core/errors.js';
import { createAgentHandlers } from '../../src/agents/handlers.js';

const allCapabilities = [
  'agent.register', 'agent.need_advance', 'agent.memory_observe', 'agent.decide',
  'agent.goal_interrupt', 'agent.goal_resume', 'agent.goal_complete',
];

function registration(overrides = {}) {
  return {
    agentId: 'agent.worker',
    actorId: 'actor.payload-forgery',
    needs: [],
    skills: { trading: 3 },
    roles: ['role.stall_worker'],
    memory: { capacity: 4, observations: [] },
    ...overrides,
  };
}

function score(candidateId, total) {
  return {
    candidateId,
    priority: 1,
    components: {
      needPressure: total, routinePriority: 0, skillFit: 0, memoryEvidence: 0,
      taskUrgency: 0, switchingCost: 0, modifiers: 0,
    },
    total,
  };
}

function command(type, payload, expectedRevision = 0, overrides = {}) {
  return {
    commandId: `command.${type}.${expectedRevision}`,
    type,
    actorId: 'actor.worker',
    roomId: 'room.market',
    issuedAt: expectedRevision,
    payload,
    expectedRevision,
    ...overrides,
  };
}

function fixture({ grants = { 'actor.worker': allCapabilities }, eventStore = createEventStore() } = {}) {
  const registry = createRegistry();
  const handlers = createAgentHandlers();
  for (const [type, handler] of Object.entries(handlers)) registry.register(type, handler);
  const engine = createEngine({
    initialState: { agentsById: {} },
    registry,
    eventStore,
    permissionPolicy: createPermissionPolicy(grants),
    idFactory: createIdFactory('event', 0),
    clock: () => 50,
  });
  return { engine, eventStore, handlers };
}

test('real engine binds ownership and emits command-bound agent facts', () => {
  const { engine, eventStore } = fixture();
  const registered = engine.dispatch(command('agent.register', registration()));
  assert.equal(registered.accepted, true);
  assert.equal(registered.events[0].commandId, 'command.agent.register.0');
  assert.equal(registered.events[0].actorId, 'actor.worker');
  assert.equal(engine.getState().agentsById['agent.worker'].actorId, 'actor.worker');

  const decision = engine.dispatch(command('agent.decide', {
    agentId: 'agent.worker',
    decisionId: 'decision.one',
    sequence: 1,
    rankedCandidates: [score('candidate.stock', 20)],
    interruptMargin: 5,
    hardInterruption: false,
    reason: 'routine_tick',
  }, 1));
  assert.equal(decision.accepted, true);
  assert.equal(engine.getState().agentsById['agent.worker'].currentGoal.candidateId, 'candidate.stock');
  assert.deepEqual(eventStore.getEvents(), [...registered.events, ...decision.events]);
});

test('capabilities stale revisions ownership and duplicates reject without mutation', () => {
  const denied = fixture({ grants: { 'actor.worker': [] } });
  assert.equal(denied.engine.dispatch(command('agent.register', registration())).rejection.code, ERROR_CODES.PERMISSION_DENIED);

  const { engine } = fixture();
  assert.equal(engine.dispatch(command('agent.register', registration(), 2)).rejection.code, ERROR_CODES.STALE_REVISION);
  assert.equal(engine.dispatch(command('agent.register', registration())).accepted, true);
  assert.equal(engine.dispatch(command('agent.register', registration(), 1)).rejection.code, 'agent.duplicate');

  const foreign = engine.dispatch(command('agent.memory_observe', {
    agentId: 'agent.worker',
    observation: {
      memoryId: 'memory.one', kind: 'market.stock_seen', subjectId: 'stall.one',
      sequence: 1, salience: 2, data: {},
    },
  }, 1, { actorId: 'actor.other' }));
  assert.equal(foreign.rejection.code, ERROR_CODES.PERMISSION_DENIED);
  assert.equal(engine.getRevision(), 1);
});

test('owned actor with capability cannot mutate another actors agent', () => {
  const grants = { 'actor.worker': allCapabilities, 'actor.other': allCapabilities };
  const { engine } = fixture({ grants });
  assert.equal(engine.dispatch(command('agent.register', registration())).accepted, true);
  const result = engine.dispatch(command('agent.memory_observe', {
    agentId: 'agent.worker',
    observation: {
      memoryId: 'memory.one', kind: 'market.stock_seen', subjectId: 'stall.one',
      sequence: 1, salience: 2, data: {},
    },
  }, 1, { actorId: 'actor.other' }));
  assert.equal(result.rejection.code, 'agent.forbidden');
  assert.equal(engine.getRevision(), 1);
});

test('recorded facts replay exactly without selecting another winner', () => {
  const { engine, handlers } = fixture();
  const initial = engine.getState();
  const registered = engine.dispatch(command('agent.register', registration()));
  const afterRegister = handlers['agent.register'].reduce(initial, registered.events[0]);
  const decision = engine.dispatch(command('agent.decide', {
    agentId: 'agent.worker', decisionId: 'decision.one', sequence: 1,
    rankedCandidates: [score('candidate.stock', 20), score('candidate.clean', 10)],
    interruptMargin: 5, hardInterruption: false, reason: 'routine_tick',
  }, 1));
  const replayed = handlers['agent.decide'].reduce(afterRegister, decision.events[0]);
  assert.deepEqual(replayed, engine.getState());
  assert.equal(replayed.agentsById['agent.worker'].currentGoal.candidateId, 'candidate.stock');
});

test('forged events and event-store commit failures publish no state', () => {
  const forgedRegistry = createRegistry();
  forgedRegistry.register('agent.register', {
    decide(_state, _command, context) {
      const event = context.createEvent('agent.registered', registration());
      return { accepted: true, events: [{ ...event }], rejection: null };
    },
    reduce: createAgentHandlers()['agent.register'].reduce,
  });
  const forged = createEngine({
    initialState: { agentsById: {} }, registry: forgedRegistry, eventStore: createEventStore(),
    permissionPolicy: createPermissionPolicy({ 'actor.worker': ['agent.register'] }),
    idFactory: createIdFactory('event', 0), clock: () => 50,
  });
  assert.equal(forged.dispatch(command('agent.register', registration())).rejection.code, ERROR_CODES.INVALID_EVENT);
  assert.deepEqual(forged.getState(), { agentsById: {} });

  let rolledBack = false;
  const failingStore = {
    append() {},
    beginTransaction() {
      return {
        append() {},
        commit() { throw new Error('commit failed'); },
        rollback() { rolledBack = true; },
      };
    },
  };
  const failed = fixture({ eventStore: failingStore }).engine;
  assert.throws(() => failed.dispatch(command('agent.register', registration())), /commit failed/);
  assert.equal(rolledBack, true);
  assert.deepEqual(failed.getState(), { agentsById: {} });
});

test('need reducer rejects replaying an older advancement over newer agent state', () => {
  const { engine, handlers } = fixture();
  const definition = {
    needId: 'need.hunger', minimum: 0, maximum: 100, initial: 100,
    interval: 10, decayPerInterval: 5, weight: 1,
    urgencyPoints: [{ value: 0, urgency: 100 }, { value: 100, urgency: 0 }],
  };
  assert.equal(engine.dispatch(command('agent.register', registration({
    needs: [{ needId: 'need.hunger', value: 100, lastSequence: 0, appliedIntervals: 0 }],
  }))).accepted, true);
  const first = engine.dispatch(command('agent.need_advance', {
    agentId: 'agent.worker', definition, targetSequence: 10,
  }, 1));
  const second = engine.dispatch(command('agent.need_advance', {
    agentId: 'agent.worker', definition, targetSequence: 20,
  }, 2));
  assert.equal(second.accepted, true);
  assert.throws(() => handlers['agent.need_advance'].reduce(engine.getState(), first.events[0]), TypeError);
});
