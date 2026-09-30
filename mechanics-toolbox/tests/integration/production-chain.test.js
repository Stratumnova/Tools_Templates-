import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelProduction,
  completeProduction,
  createCommand,
  createCraftingHandlers,
  createEngine,
  createEvent,
  createEventStore,
  createIdFactory,
  createPermissionPolicy,
  createRegistry,
  queueProduction,
  startProduction,
} from '../../src/index.js';
import { definitionsById, matchingState, recipe } from '../helpers/crafting-fixtures.js';

function ids(...values) {
  let index = 0;
  return () => values[index++];
}

const queueInput = () => ({
  actorId: 'npc.crafter', sourceContainerId: 'bag', outputContainerId: 'output',
  stationId: 'bench', queuedAt: 100, skill: 60, roll: 0.5,
});

const queueContext = () => ({
  definitionsById,
  nextCraftJobId: ids('craft-job-1'),
  nextReservationId: ids('ingredient-1', 'ingredient-2', 'station-1'),
});

test('queue atomically reserves exact ingredients and one station without consuming tools', () => {
  const state = matchingState();
  const input = queueInput();
  const result = queueProduction(state, recipe(), input, queueContext());

  assert.equal(result.job.status, 'QUEUED');
  assert.equal(result.job.craftJobId, 'craft-job-1');
  assert.deepEqual(result.job.inputReservationIds, ['ingredient-1', 'ingredient-2']);
  assert.equal(result.job.stationReservationId, 'station-1');
  assert.equal(result.state.reservationsById['ingredient-1'].itemId, 'material.wood');
  assert.equal(result.state.reservationsById['ingredient-2'].itemId, 'material.rope');
  assert.equal(result.state.taskReservationsById['station-1'].resourceKey, 'station:bench');
  assert.equal(result.state.containersById.bag.stacks.find(stack => stack.stackId === 'knife-a').quantity, 1);
  assert.equal(result.event.type, 'craft.queued');
  assert.equal(Object.isFrozen(result.job), true);
  assert.deepEqual(state, matchingState());
  assert.equal(Object.isFrozen(input), false);
});

test('late queue validation is atomic and practical preflight failures do not advance IDs', () => {
  const state = matchingState();
  state.taskReservationsById.busy = {
    reservationId: 'busy', taskId: 'other-job', resourceType: 'station', resourceId: 'bench',
    resourceKey: 'station:bench', createdAt: 50,
  };
  const before = structuredClone(state); let calls = 0;
  const context = {
    definitionsById,
    nextCraftJobId: () => { calls += 1; return 'craft-job-1'; },
    nextReservationId: () => { calls += 1; return `reservation-${calls}`; },
  };
  assert.throws(() => queueProduction(state, recipe(), queueInput(), context), {
    code: 'craft.station_unavailable',
  });
  assert.equal(calls, 0);
  assert.deepEqual(state, before);
});

test('queue rejects generated job collisions without publishing partial reservations', () => {
  const first = queueProduction(matchingState(), recipe(), queueInput(), queueContext());
  const state = cancelProduction(first.state, first.job.craftJobId, {
    actorId: 'npc.crafter', stationId: 'bench', cancelledAt: 100,
  }, {}).state;
  const before = structuredClone(state);
  assert.throws(() => queueProduction(state, recipe(), queueInput(), queueContext()), {
    code: 'craft.id_collision',
  });
  assert.deepEqual(state, before);
});

test('start enforces actor, station, chronology, and safe end time while accepting equal boundaries', () => {
  const queued = queueProduction(matchingState(), recipe(), queueInput(), queueContext()).state;
  assert.throws(() => startProduction(queued, 'craft-job-1', {
    actorId: 'other', stationId: 'bench', startedAt: 100,
  }, {}), { code: 'craft.wrong_actor' });
  assert.throws(() => startProduction(queued, 'craft-job-1', {
    actorId: 'npc.crafter', stationId: 'other', startedAt: 100,
  }, {}), { code: 'craft.wrong_station' });
  assert.throws(() => startProduction(queued, 'craft-job-1', {
    actorId: 'npc.crafter', stationId: 'bench', startedAt: 99,
  }, {}), { code: 'craft.invalid_time' });

  const started = startProduction(queued, 'craft-job-1', {
    actorId: 'npc.crafter', stationId: 'bench', startedAt: 100,
  }, {});
  assert.equal(started.job.status, 'ACTIVE');
  assert.equal(started.job.endsAt, 110);

  const overflowRecipe = { ...recipe(), durationMs: Number.MAX_SAFE_INTEGER };
  const overflowQueued = queueProduction(matchingState(), overflowRecipe, queueInput(), queueContext()).state;
  assert.throws(() => startProduction(overflowQueued, 'craft-job-1', {
    actorId: 'npc.crafter', stationId: 'bench', startedAt: 100,
  }, {}), { code: 'craft.invalid_time' });

  const boundaryQueued = queueProduction(matchingState(), recipe(), queueInput(), queueContext()).state;
  const boundary = startProduction(boundaryQueued, 'craft-job-1', {
    actorId: 'npc.crafter', stationId: 'bench',
    startedAt: Number.MAX_SAFE_INTEGER - recipe().durationMs,
  }, {});
  assert.equal(boundary.job.endsAt, Number.MAX_SAFE_INTEGER);
});

function activeState() {
  const queued = queueProduction(matchingState(), recipe(), queueInput(), queueContext()).state;
  return startProduction(queued, 'craft-job-1', {
    actorId: 'npc.crafter', stationId: 'bench', startedAt: 100,
  }, {}).state;
}

test('completion consumes exact reservations, creates outputs and byproducts once, and releases station', () => {
  const state = activeState();
  const result = completeProduction(state, 'craft-job-1', {
    actorId: 'npc.crafter', stationId: 'bench', completedAt: 110,
  }, { definitionsById, nextStackId: ids('trap-stack', 'scrap-stack') });

  assert.equal(result.job.status, 'COMPLETED');
  assert.equal(result.job.completedAt, 110);
  assert.deepEqual(result.state.reservationsById, {});
  assert.deepEqual(result.state.taskReservationsById, {});
  assert.deepEqual(result.state.containersById.output.stacks.map(stack => ({
    stackId: stack.stackId, itemId: stack.itemId, quantity: stack.quantity, quality: stack.quality,
  })), [
    { stackId: 'trap-stack', itemId: 'item.trap', quantity: 1, quality: 79 },
    { stackId: 'scrap-stack', itemId: 'material.scrap', quantity: 1, quality: null },
  ]);
  assert.throws(() => completeProduction(result.state, 'craft-job-1', {
    actorId: 'npc.crafter', stationId: 'bench', completedAt: 111,
  }, { definitionsById, nextStackId: ids('duplicate') }), { code: 'craft.invalid_transition' });
  assert.equal(result.state.containersById.output.stacks.length, 2);
});

test('completion rejects early, backward, foreign, or wrong-station attempts without mutation', () => {
  const active = activeState();
  for (const input of [
    { actorId: 'npc.crafter', stationId: 'bench', completedAt: 109 },
    { actorId: 'npc.crafter', stationId: 'bench', completedAt: 99 },
    { actorId: 'other', stationId: 'bench', completedAt: 110 },
    { actorId: 'npc.crafter', stationId: 'other', completedAt: 110 },
  ]) {
    const before = structuredClone(active);
    assert.throws(() => completeProduction(active, 'craft-job-1', input, {
      definitionsById, nextStackId: ids('unused'),
    }), error => error?.code?.startsWith('craft.'));
    assert.deepEqual(active, before);
  }
});

test('cancellation before and after start releases all reservations exactly once and creates no output', () => {
  const queued = queueProduction(matchingState(), recipe(), queueInput(), queueContext()).state;
  const cancelledQueued = cancelProduction(queued, 'craft-job-1', {
    actorId: 'npc.crafter', stationId: 'bench', cancelledAt: 100,
  }, {});
  assert.equal(cancelledQueued.job.status, 'CANCELLED');
  assert.deepEqual(cancelledQueued.state.reservationsById, {});
  assert.deepEqual(cancelledQueued.state.taskReservationsById, {});
  assert.deepEqual(cancelledQueued.state.containersById.output.stacks, []);
  assert.throws(() => cancelProduction(cancelledQueued.state, 'craft-job-1', {
    actorId: 'npc.crafter', stationId: 'bench', cancelledAt: 101,
  }, {}), { code: 'craft.invalid_transition' });

  const active = activeState();
  const cancelledActive = cancelProduction(active, 'craft-job-1', {
    actorId: 'npc.crafter', stationId: 'bench', cancelledAt: 105,
  }, {});
  assert.equal(cancelledActive.job.status, 'CANCELLED');
  assert.deepEqual(cancelledActive.state.reservationsById, {});
  assert.deepEqual(cancelledActive.state.taskReservationsById, {});
  assert.deepEqual(cancelledActive.state.containersById.output.stacks, []);
});

test('real engine dispatch records command-bound facts and reducers replay without recalculation', () => {
  const registry = createRegistry();
  const handlers = createCraftingHandlers({
    recipesById: { 'craft.trap': recipe() }, definitionsById,
    nextCraftJobId: ids('craft-job-1'),
    nextReservationId: ids('ingredient-1', 'ingredient-2', 'station-1'),
    nextStackId: ids('trap-stack', 'scrap-stack'),
  });
  for (const [type, handler] of Object.entries(handlers)) registry.register(type, handler);
  const eventStore = createEventStore();
  const engine = createEngine({
    initialState: matchingState(), registry, eventStore,
    permissionPolicy: createPermissionPolicy({ 'npc.crafter': ['*'] }),
    idFactory: createIdFactory('event', 0), clock: () => 500,
  });
  let commandSequence = 0;
  const dispatch = (type, payload) => {
    commandSequence += 1;
    return engine.dispatch(createCommand({
      commandId: `command-${commandSequence}`, type, actorId: 'npc.crafter', roomId: 'workshop',
      issuedAt: 500, payload, expectedRevision: engine.getRevision(),
    }));
  };

  const queued = dispatch('craft.queue', {
    recipeId: 'craft.trap', sourceContainerId: 'bag', outputContainerId: 'output',
    stationId: 'bench', queuedAt: 100, skill: 60, roll: 0.5,
  });
  assert.equal(queued.accepted, true);
  assert.equal(queued.events[0].type, 'craft.queued');
  assert.equal(queued.events[0].commandId, 'command-1');
  assert.equal(dispatch('craft.start', { craftJobId: 'craft-job-1', stationId: 'bench', startedAt: 100 }).accepted, true);
  const completed = dispatch('craft.complete', { craftJobId: 'craft-job-1', stationId: 'bench', completedAt: 110 });
  assert.equal(completed.accepted, true);
  assert.equal(completed.events[0].payload.job.quality, 79);
  assert.equal(engine.getState().craftJobsById['craft-job-1'].status, 'COMPLETED');
  assert.equal(engine.getState().containersById.output.stacks[0].quantity, 1);

  const forged = createEvent({
    eventId: 'forged', type: 'craft.completed', commandId: 'forged-command', actorId: 'npc.crafter',
    roomId: 'workshop', occurredAt: 500, payload: completed.events[0].payload, schemaVersion: '1.0.0',
  });
  registry.register('craft.forge', {
    decide: () => ({ accepted: true, events: [forged], rejection: null }),
    reduce: handlers['craft.complete'].reduce,
  });
  const forgedResult = dispatch('craft.forge', {});
  assert.equal(forgedResult.accepted, false);
  assert.equal(forgedResult.rejection.code, 'INVALID_EVENT');
});
