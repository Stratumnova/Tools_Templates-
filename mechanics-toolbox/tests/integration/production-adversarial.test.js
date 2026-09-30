import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addItem,
  cancelProduction,
  completeProduction,
  createCommand,
  createCraftingHandlers,
  createEngine,
  createEventStore,
  createIdFactory,
  createInventoryHandlers,
  createPermissionPolicy,
  createRegistry,
  queueProduction,
  releaseReservation,
  releaseTaskResources,
  reserveQuantity,
  reserveTaskResources,
  startProduction,
  validateRecipe,
} from '../../src/index.js';
import { definitionsById as baseDefinitions, matchingState, recipe } from '../helpers/crafting-fixtures.js';

const queueInput = {
  actorId: 'npc.crafter', sourceContainerId: 'bag', outputContainerId: 'output',
  stationId: 'bench', queuedAt: 100, skill: 60, roll: 0.5,
};
const owner = { actorId: 'npc.crafter', stationId: 'bench' };
const coded = error => typeof error?.code === 'string' && error.code.startsWith('craft.');

function context() {
  return {
    definitionsById: structuredClone(baseDefinitions),
    nextCraftJobId: createIdFactory('job', 0),
    nextReservationId: createIdFactory('res', 0),
    nextStackId: createIdFactory('out', 0),
  };
}

function queued(customRecipe = recipe(), customContext = context(), state = matchingState(), input = queueInput) {
  return queueProduction(state, customRecipe, input, customContext);
}

function active(customRecipe = recipe(), customContext = context()) {
  const result = queued(customRecipe, customContext);
  return startProduction(result.state, result.job.craftJobId, { ...owner, startedAt: 100 }, {});
}

function completed(result, customContext = context()) {
  return completeProduction(result.state, result.job.craftJobId, {
    ...owner, completedAt: 110,
  }, customContext);
}

function engineHarness(customContext = context(), customRecipe = recipe()) {
  const crafting = createCraftingHandlers({
    ...customContext, recipesById: { [customRecipe.recipeId]: customRecipe },
  });
  const inventory = createInventoryHandlers({
    definitionsById: customContext.definitionsById, nextStackId: customContext.nextStackId,
  });
  const registry = createRegistry();
  for (const [type, handler] of Object.entries({ ...inventory, ...crafting })) registry.register(type, handler);
  const engine = createEngine({
    initialState: matchingState(), registry, eventStore: createEventStore(),
    permissionPolicy: createPermissionPolicy({ 'npc.crafter': ['*'], other: ['*'] }),
    idFactory: createIdFactory('event', 0), clock: () => 500,
  });
  let sequence = 0;
  const dispatch = (type, payload, actorId = 'npc.crafter') => {
    sequence += 1;
    return engine.dispatch(createCommand({
      commandId: `command-${sequence}`, type, payload, actorId, roomId: 'workshop',
      issuedAt: 500, expectedRevision: engine.getRevision(),
    }));
  };
  return { crafting, dispatch, engine };
}

test('A13 completion replay uses recorded placement and consumes every recorded output ID exactly', () => {
  const initialContext = context();
  const customRecipe = recipe();
  customRecipe.outputs[0].quantity = 2;
  initialContext.definitionsById['item.trap'].stackLimit = 1;
  const result = active(customRecipe, initialContext);
  const completion = completed(result, initialContext);

  const firstHandlers = createCraftingHandlers({
    ...initialContext, recipesById: { [customRecipe.recipeId]: customRecipe },
  });
  const expected = firstHandlers['craft.complete'].reduce(result.state, completion.event);
  initialContext.definitionsById['item.trap'].stackLimit = 10;
  assert.equal(Object.isFrozen(initialContext.definitionsById), false);
  const replayHandlers = createCraftingHandlers({
    ...initialContext, recipesById: {},
    nextCraftJobId: () => { throw new Error('factory used during replay'); },
    nextReservationId: () => { throw new Error('factory used during replay'); },
    nextStackId: () => { throw new Error('factory used during replay'); },
  });
  assert.deepEqual(replayHandlers['craft.complete'].reduce(result.state, completion.event), expected);

  const surplus = structuredClone(completion.event);
  surplus.payload.additions[0].stackIds.push('surplus-output-id');
  assert.throws(() => replayHandlers['craft.complete'].reduce(result.state, surplus), coded);

  const placementRecipe = recipe();
  placementRecipe.byproducts = [];
  const placementState = matchingState();
  placementState.containersById.output.stacks.push({
    stackId: 'existing-output', itemId: 'item.trap', quantity: 1,
    quality: 79, durability: null, metadata: {},
  });
  const placementContext = context();
  const placementQueued = queued(placementRecipe, placementContext, placementState);
  const placementActive = startProduction(placementQueued.state, placementQueued.job.craftJobId, {
    ...owner, startedAt: 100,
  }, {});
  const placementCompletion = completed(placementActive, placementContext);
  const replacement = structuredClone(placementCompletion.event);
  replacement.payload.additions[0].stackIds = ['replacement-output'];
  replacement.payload.additions[0].afterStacks = [{
    stackId: 'replacement-output', itemId: 'item.trap', quantity: 1,
    quality: 79, durability: null, metadata: {},
  }];
  assert.throws(() => replayHandlers['craft.complete'].reduce(placementActive.state, replacement), coded);
});

test('A14 completion and cancellation reject reused inventory reservation IDs with replacement facts', () => {
  const harness = engineHarness();
  assert.equal(harness.dispatch('craft.queue', { ...queueInput, recipeId: 'craft.trap' }).accepted, true);
  assert.equal(harness.dispatch('craft.start', {
    craftJobId: 'job-000001', stationId: 'bench', startedAt: 100,
  }).accepted, true);
  assert.equal(harness.dispatch('inventory.release_reservation', { reservationId: 'res-000001' }, 'other').accepted, true);
  assert.equal(harness.dispatch('inventory.reserve', {
    reservationId: 'res-000001', containerId: 'bag', itemId: 'material.vine', quantity: 1,
  }, 'other').accepted, true);
  assert.equal(harness.dispatch('craft.complete', {
    craftJobId: 'job-000001', stationId: 'bench', completedAt: 110,
  }).accepted, false);

  const direct = queued();
  let replaced = releaseReservation(direct.state, direct.job.inputReservationIds[0]);
  replaced = reserveQuantity(replaced, {
    reservationId: direct.job.inputReservationIds[0], containerId: 'bag',
    itemId: 'material.vine', quantity: 1,
  });
  assert.throws(() => cancelProduction(replaced, direct.job.craftJobId, {
    ...owner, cancelledAt: 100,
  }, {}), coded);
});

test('A15 transitions require the exact live station reservation generation and identity', () => {
  const result = queued();
  const released = releaseTaskResources({ reservationsById: result.state.taskReservationsById }, {
    taskId: result.job.craftJobId, reservationIds: [result.job.stationReservationId],
  });
  const missing = structuredClone(result.state);
  missing.taskReservationsById = released.reservationsById;
  assert.throws(() => startProduction(missing, result.job.craftJobId, {
    ...owner, startedAt: 100,
  }, {}), coded);

  const replacement = reserveTaskResources(released, {
    taskId: result.job.craftJobId, createdAt: 100,
    resources: [{
      reservationId: result.job.stationReservationId,
      resourceType: 'station', resourceId: 'other-station',
    }],
  });
  const replaced = structuredClone(result.state);
  replaced.taskReservationsById = replacement.reservationsById;
  assert.throws(() => startProduction(replaced, result.job.craftJobId, {
    ...owner, startedAt: 100,
  }, {}), coded);
});

test('A16 stored jobs reject malformed nested facts and inconsistent status chronology', () => {
  const result = active();
  const mutations = [
    job => { job.endsAt = 100; },
    job => { job.outputs[0] = { itemId: 'bad id', quantity: -1 }; },
    job => { job.ingredients[0].allocations[0].quantity += 1; },
    job => { job.startedAt = null; },
    job => { job.byproducts[0].itemId = job.outputs[0].itemId; },
    job => { job.outputs[0].quality = 101; },
  ];
  for (const mutate of mutations) {
    const state = structuredClone(result.state);
    mutate(state.craftJobsById[result.job.craftJobId]);
    assert.throws(() => completeProduction(state, result.job.craftJobId, {
      ...owner, completedAt: 110,
    }, context()), coded);
  }
});

test('A17 predictable full-plan capacity failure does not advance output IDs', () => {
  const result = active();
  const customContext = context();
  const state = addItem(result.state, {
    containerId: 'output', itemId: 'material.vine', quantity: 19,
    quality: null, durability: null, metadata: {},
    definition: customContext.definitionsById['material.vine'],
    definitionsById: customContext.definitionsById,
    nextStackId: () => 'filler',
  });
  let calls = 0;
  customContext.nextStackId = () => `new-${++calls}`;
  assert.throws(() => completeProduction(state, result.job.craftJobId, {
    ...owner, completedAt: 110,
  }, customContext), coded);
  assert.equal(calls, 0);
});

test('A18 hostile auxiliary configuration rejects with craft codes without executing accessors', () => {
  let calls = 0;
  const options = {};
  Object.defineProperty(options, 'existingRecipesById', {
    enumerable: true,
    get() { calls += 1; return {}; },
  });
  assert.throws(() => validateRecipe(recipe(), options), coded);
  assert.equal(calls, 0);

  const customContext = context();
  Object.defineProperty(customContext.definitionsById, 'item.trap', {
    enumerable: true,
    get() { calls += 1; return baseDefinitions['item.trap']; },
  });
  assert.throws(() => queued(recipe(), customContext), coded);
  assert.equal(calls, 0);

  const handlerOptions = context();
  Object.defineProperty(handlerOptions, 'recipesById', {
    enumerable: true,
    get() { calls += 1; return { 'craft.trap': recipe() }; },
  });
  assert.throws(() => createCraftingHandlers(handlerOptions), coded);
  assert.equal(calls, 0);
});

test('A19 every resolved definition requires map key equality before queue IDs or reservations', () => {
  for (const itemId of ['tool.knife', 'item.trap', 'material.scrap']) {
    const customContext = context();
    customContext.definitionsById[itemId].itemId = 'different-item';
    let calls = 0;
    customContext.nextCraftJobId = customContext.nextReservationId = () => `id-${++calls}`;
    assert.throws(() => queued(recipe(), customContext), coded);
    assert.equal(calls, 0);
  }
});

test('A20 reducers reject stale terminal reversal and altered immutable job plans', () => {
  const customContext = context();
  const started = active(recipe(), customContext);
  const finished = completed(started, customContext);
  const handlers = createCraftingHandlers({
    ...customContext, recipesById: { 'craft.trap': recipe() },
  });
  assert.throws(() => handlers['craft.start'].reduce(finished.state, started.event), coded);
  assert.throws(() => handlers['craft.complete'].reduce(finished.state, finished.event), coded);

  const replayContext = context();
  const beforeStart = queued(recipe(), replayContext);
  const validStart = startProduction(beforeStart.state, beforeStart.job.craftJobId, {
    ...owner, startedAt: 100,
  }, {});
  const altered = structuredClone(validStart.event);
  altered.payload.job.outputs[0].quantity = 99;
  assert.throws(() => handlers['craft.start'].reduce(beforeStart.state, altered), coded);
});
