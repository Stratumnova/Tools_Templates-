import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceOffline, createCommand, createEngine, createEventStore, createIdFactory,
  claimTask, createPermissionPolicy, createRegistry, createTask, createTimeTaskHandlers, startTask,
} from '../../src/index.js';

function active(taskId, endsAt) {
  const available = createTask({ taskId, taskType: 'work.basic', priority: 0, payload: {}, durationMs: 5, createdAt: 0, reservationIds: [] });
  const claimed = claimTask(available, { actorId: 'worker', claimedAt: 0 }).task;
  return startTask(claimed, { actorId: 'worker', startedAt: endsAt - 5 }).task;
}

function context() {
  let id = 0;
  return { createEvent(type, payload) { id += 1; return Object.freeze({ type, payload, eventId: `e-${id}` }); } };
}

function storedClaim(claimId = 'offline-1') {
  return {
    claimId, from: 0, requestedTo: 10, effectiveTo: 5, maxDurationMs: 5,
    summary: {
      status: 'PROCESSED', requestedDurationMs: 10, processedDurationMs: 5,
      clamped: true, completedTaskIds: [],
    },
  };
}

test('offline advancement clamps, orders completions chronologically, and respects interval boundaries', () => {
  const state = {
    clock: { now: 10 },
    tasksById: { late: active('late', 20), tie_b: active('tie_b', 15), tie_a: active('tie_a', 15), before: active('before', 10), after: active('after', 21) },
    offlineClaimsById: {},
  };
  const result = advanceOffline(state, { from: 10, to: 30, maxDurationMs: 10, claimId: 'offline-1' }, context());
  assert.equal(result.claimId, 'offline-1');
  assert.deepEqual(result.events.map(event => event.type), [
    'offline.claim_recorded', 'task.completed', 'task.completed', 'task.completed', 'clock.advanced',
  ]);
  assert.deepEqual(result.events.slice(1, 4).map(event => event.payload.task.taskId), ['tie_a', 'tie_b', 'late']);
  assert.deepEqual(result.summary, {
    status: 'PROCESSED', requestedDurationMs: 20, processedDurationMs: 10,
    clamped: true, completedTaskIds: ['tie_a', 'tie_b', 'late'],
  });
  assert.equal(Object.isFrozen(result.summary), true);
  assert.equal(result.events[0].payload.from, 10);
  assert.equal(result.events[0].payload.requestedTo, 30);
  assert.equal(result.events[0].payload.effectiveTo, 20);
  assert.deepEqual(state.tasksById.late.status, 'ACTIVE');
});

test('duplicate claims short-circuit old interval validation and zero-duration claims remain ordered', () => {
  const duplicate = advanceOffline({
    clock: { now: 99 }, tasksById: {}, offlineClaimsById: { 'offline-1': storedClaim() },
  }, { from: -5, to: -10, maxDurationMs: 0, claimId: 'offline-1' }, context());
  assert.deepEqual(duplicate.events, []);
  assert.equal(duplicate.summary.status, 'ALREADY_CLAIMED');

  const zero = advanceOffline({ clock: { now: 10 }, tasksById: {}, offlineClaimsById: {} },
    { from: 10, to: 10, maxDurationMs: 5, claimId: 'zero' }, context());
  assert.deepEqual(zero.events.map(event => event.type), ['offline.claim_recorded', 'clock.advanced']);
  assert.equal(zero.summary.processedDurationMs, 0);
});

test('offline advancement rejects malformed state and unsafe fresh intervals without mutation', () => {
  const valid = { clock: { now: 0 }, tasksById: {}, offlineClaimsById: {} };
  for (const state of [
    { ...valid, tasksById: { bad: {} } },
    { ...valid, offlineClaimsById: { bad: {} } },
    { ...valid, clock: { now: -1 } },
  ]) assert.throws(() => advanceOffline(state, { from: 0, to: 1, maxDurationMs: 1, claimId: 'claim' }, context()));
  assert.throws(() => advanceOffline(valid, { from: 1, to: 2, maxDurationMs: 1, claimId: 'claim' }, context()));
  assert.throws(() => advanceOffline(valid, { from: 0, to: 1, maxDurationMs: 0, claimId: 'claim' }, context()));
  assert.throws(() => advanceOffline({ ...valid, clock: { now: Number.MAX_SAFE_INTEGER } }, {
    from: Number.MAX_SAFE_INTEGER, to: Number.MAX_SAFE_INTEGER, maxDurationMs: 1, claimId: 'claim',
  }, context()), RangeError);
});

test('fresh and duplicate claims reject status-incoherent tasks and incomplete stored claim facts', () => {
  const malformedActive = { ...active('task-1', 5), endsAt: null };
  const valid = { clock: { now: 0 }, tasksById: {}, offlineClaimsById: {} };
  const input = { from: 0, to: 1, maxDurationMs: 1, claimId: 'claim' };
  assert.throws(() => advanceOffline({ ...valid, tasksById: { 'task-1': malformedActive } }, input, context()));

  const malformedClaims = [
    { ...storedClaim('old'), from: -1 },
    { ...storedClaim('old'), requestedTo: -1 },
    { ...storedClaim('old'), effectiveTo: 6 },
    { ...storedClaim('old'), maxDurationMs: 0 },
    { ...storedClaim('old'), summary: { ...storedClaim('old').summary, processedDurationMs: 4 } },
    { ...storedClaim('old'), summary: { ...storedClaim('old').summary, completedTaskIds: ['bad id'] } },
  ];
  for (const claim of malformedClaims) {
    assert.throws(() => advanceOffline({ ...valid, offlineClaimsById: { old: claim } }, input, context()));
  }

  const corruptDuplicateStates = [
    { clock: { now: -1 }, tasksById: {}, offlineClaimsById: { claim: storedClaim('claim') } },
    { clock: { now: 0 }, tasksById: { 'task-1': malformedActive }, offlineClaimsById: { claim: storedClaim('claim') } },
    { clock: { now: 0 }, tasksById: {}, offlineClaimsById: { claim: { claimId: 'claim' } } },
  ];
  for (const state of corruptDuplicateStates) {
    assert.throws(() => advanceOffline(state,
      { from: -5, to: -10, maxDurationMs: 0, claimId: 'claim' }, context()));
  }
});

test('engine enforces monotonic task timestamps and accepts equal boundaries through reclaim', () => {
  const registry = createRegistry();
  for (const [type, handler] of Object.entries(createTimeTaskHandlers())) registry.register(type, handler);
  const engine = createEngine({
    initialState: { clock: { now: 0 }, tasksById: {}, offlineClaimsById: {} }, registry,
    eventStore: createEventStore(), permissionPolicy: createPermissionPolicy({ worker: ['*'] }),
    idFactory: createIdFactory('evt', 0), clock: () => 100,
  });
  const dispatch = (type, payload) => engine.dispatch(createCommand({
    commandId: `cmd-${engine.getRevision()}`, type, actorId: 'worker', roomId: 'room',
    issuedAt: 0, payload, expectedRevision: engine.getRevision(),
  }));
  assert.equal(dispatch('task.create', {
    taskId: 'task-time', taskType: 'work.basic', priority: 0, payload: {}, durationMs: 5,
    createdAt: 10, reservationIds: [],
  }).accepted, true);
  for (const [type, badPayload, goodPayload] of [
    ['task.claim', { taskId: 'task-time', claimedAt: 9 }, { taskId: 'task-time', claimedAt: 10 }],
    ['task.start', { taskId: 'task-time', startedAt: 9 }, { taskId: 'task-time', startedAt: 10 }],
    ['task.interrupt', { taskId: 'task-time', interruptedAt: 9 }, { taskId: 'task-time', interruptedAt: 10 }],
    ['task.claim', { taskId: 'task-time', claimedAt: 9 }, { taskId: 'task-time', claimedAt: 10 }],
    ['task.start', { taskId: 'task-time', startedAt: 9 }, { taskId: 'task-time', startedAt: 10 }],
    ['task.complete', { taskId: 'task-time', completedAt: 14 }, { taskId: 'task-time', completedAt: 15 }],
  ]) {
    assert.equal(dispatch(type, badPayload).accepted, false, `${type} backward`);
    assert.equal(dispatch(type, goodPayload).accepted, true, `${type} equal boundary`);
  }
  assert.equal(engine.getState().tasksById['task-time'].status, 'COMPLETED');
});

test('real engine dispatch replays lifecycle and offline facts idempotently', () => {
  const registry = createRegistry();
  const handlers = createTimeTaskHandlers();
  for (const [type, handler] of Object.entries(handlers)) registry.register(type, handler);
  const engine = createEngine({
    initialState: { clock: { now: 0 }, tasksById: {}, offlineClaimsById: {} }, registry,
    eventStore: createEventStore(), permissionPolicy: createPermissionPolicy({ worker: ['*'] }),
    idFactory: createIdFactory('evt', 0), clock: () => 100,
  });
  const dispatch = (type, payload) => engine.dispatch(createCommand({
    commandId: `cmd-${engine.getRevision()}`, type, actorId: 'worker', roomId: 'room',
    issuedAt: 0, payload, expectedRevision: engine.getRevision(),
  }));
  assert.equal(dispatch('task.create', {
    taskId: 'task-1', taskType: 'work.basic', priority: 0, payload: {}, durationMs: 5,
    createdAt: 0, reservationIds: [],
  }).accepted, true);
  assert.equal(dispatch('task.claim', { taskId: 'task-1', claimedAt: 0 }).accepted, true);
  assert.equal(dispatch('task.start', { taskId: 'task-1', startedAt: 0 }).accepted, true);
  const first = dispatch('offline.advance', { from: 0, to: 10, maxDurationMs: 10, claimId: 'offline-1' });
  assert.equal(first.accepted, true);
  assert.deepEqual(first.events.map(event => event.type), ['offline.claim_recorded', 'task.completed', 'clock.advanced']);
  assert.equal(engine.getState().tasksById['task-1'].status, 'COMPLETED');
  const second = dispatch('offline.advance', { from: 999, to: 0, maxDurationMs: 0, claimId: 'offline-1' });
  assert.equal(second.accepted, true);
  assert.deepEqual(second.events, []);
  assert.equal(engine.getState().tasksById['task-1'].status, 'COMPLETED');
});
