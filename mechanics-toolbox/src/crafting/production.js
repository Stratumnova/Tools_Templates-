import { accept, reject } from '../core/contracts.js';
import { isStableIdentifier } from '../core/identifiers.js';
import { copyImmutableData } from '../core/immutable-data.js';
import { addItem, inventoryInternals } from '../inventory/inventory.js';
import { consumeReservation, releaseReservation, reserveQuantity } from '../inventory/reservations.js';
import { releaseTaskResources, reserveTaskResources } from '../tasks/reservations.js';
import {
  CraftingError,
  calculateQuality,
  craftingError,
  matchRecipeInputs,
  recipeInternals,
  validateRecipe,
} from './recipes.js';

export const CRAFT_JOB_STATUSES = Object.freeze(['QUEUED', 'ACTIVE', 'COMPLETED', 'CANCELLED']);

const STATUS_SET = new Set(CRAFT_JOB_STATUSES);

function requireId(value, name) {
  if (!isStableIdentifier(value)) throw craftingError('craft.invalid_input', `${name} must be a stable identifier`);
}

function requireTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw craftingError('craft.invalid_time', `${name} must be a non-negative safe integer`);
  }
}

function cloneInput(value, name = 'input') {
  return recipeInternals.immutableClone(value, name);
}

function invalidState(message) {
  throw craftingError('craft.invalid_state', message);
}

function requireRecord(value, name) {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    invalidState(`${name} must be a plain object`);
  }
}

function requireRecordKeys(value, expected, name) {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) {
    invalidState(`${name} contains unexpected or missing fields`);
  }
}

function requireStateId(value, name) {
  if (!isStableIdentifier(value)) invalidState(`${name} must be a stable identifier`);
}

function requireStateTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) invalidState(`${name} must be a non-negative safe integer`);
}

function validateAllocation(allocation, name) {
  requireRecord(allocation, name);
  requireRecordKeys(allocation, ['stackId', 'quantity', 'quality', 'durability', 'metadata'], name);
  requireStateId(allocation.stackId, `${name}.stackId`);
  if (!Number.isSafeInteger(allocation.quantity) || allocation.quantity <= 0) {
    invalidState(`${name}.quantity must be a positive safe integer`);
  }
  requireRecord(allocation.metadata, `${name}.metadata`);
}

function validateIngredient(ingredient, name) {
  requireRecord(ingredient, name);
  requireRecordKeys(ingredient, [
    'requirementType', 'requirementId', 'itemId', 'quantity', 'allocations',
  ], name);
  if (!['input', 'substitution'].includes(ingredient.requirementType)) {
    invalidState(`${name}.requirementType is invalid`);
  }
  requireStateId(ingredient.requirementId, `${name}.requirementId`);
  requireStateId(ingredient.itemId, `${name}.itemId`);
  if (!Number.isSafeInteger(ingredient.quantity) || ingredient.quantity <= 0
      || !Array.isArray(ingredient.allocations) || ingredient.allocations.length === 0) {
    invalidState(`${name} quantity or allocations are invalid`);
  }
  const stackIds = new Set();
  let total = 0;
  for (let index = 0; index < ingredient.allocations.length; index += 1) {
    const allocation = ingredient.allocations[index];
    validateAllocation(allocation, `${name}.allocations[${index}]`);
    if (stackIds.has(allocation.stackId)) invalidState(`${name} allocation stack IDs must be unique`);
    stackIds.add(allocation.stackId);
    total += allocation.quantity;
  }
  if (!Number.isSafeInteger(total) || total !== ingredient.quantity) {
    invalidState(`${name} allocation quantity must equal ingredient quantity`);
  }
}

function validateInputReservation(reservation, ingredient, craftJobId, name) {
  requireRecord(reservation, name);
  requireRecordKeys(reservation, [
    'reservationId', 'containerId', 'itemId', 'quantity', 'allocations', 'craftJobId',
  ], name);
  for (const field of ['reservationId', 'containerId', 'itemId', 'craftJobId']) {
    requireStateId(reservation[field], `${name}.${field}`);
  }
  if (reservation.craftJobId !== craftJobId
      || reservation.itemId !== ingredient.itemId
      || reservation.quantity !== ingredient.quantity
      || !inventoryInternals.structuralEqual(reservation.allocations, ingredient.allocations)) {
    invalidState(`${name} does not match its job ingredient or generation`);
  }
}

function validateStationReservation(reservation, job, name) {
  requireRecord(reservation, name);
  requireRecordKeys(reservation, [
    'reservationId', 'taskId', 'resourceType', 'resourceId', 'resourceKey', 'createdAt', 'craftJobId',
  ], name);
  for (const field of ['reservationId', 'taskId', 'resourceId', 'craftJobId']) {
    requireStateId(reservation[field], `${name}.${field}`);
  }
  requireStateTimestamp(reservation.createdAt, `${name}.createdAt`);
  if (reservation.reservationId !== job.stationReservationId
      || reservation.taskId !== job.craftJobId
      || reservation.craftJobId !== job.craftJobId
      || reservation.resourceType !== 'station'
      || reservation.resourceId !== job.stationId
      || reservation.resourceKey !== `station:${job.stationId}`
      || reservation.createdAt !== job.queuedAt) {
    invalidState(`${name} does not match the job station generation`);
  }
}

function validateTool(tool, name) {
  requireRecord(tool, name);
  requireRecordKeys(tool, ['itemId', 'stackId', 'durability', 'condition'], name);
  requireStateId(tool.itemId, `${name}.itemId`);
  requireStateId(tool.stackId, `${name}.stackId`);
  if (tool.durability !== null && (!Number.isSafeInteger(tool.durability) || tool.durability <= 0)) {
    invalidState(`${name}.durability is invalid`);
  }
  if (!Number.isInteger(tool.condition) || tool.condition < 0 || tool.condition > 100) {
    invalidState(`${name}.condition must be an integer from 0 through 100`);
  }
}

function validateProduct(product, name) {
  requireRecord(product, name);
  requireRecordKeys(product, ['itemId', 'quantity', 'quality', 'durability', 'metadata'], name);
  requireStateId(product.itemId, `${name}.itemId`);
  if (!Number.isSafeInteger(product.quantity) || product.quantity <= 0) {
    invalidState(`${name}.quantity must be a positive safe integer`);
  }
  if (product.quality !== null && (typeof product.quality !== 'number'
      || !Number.isFinite(product.quality) || product.quality < 0 || product.quality > 100)) {
    invalidState(`${name}.quality is invalid`);
  }
  if (product.durability !== null && (!Number.isSafeInteger(product.durability) || product.durability <= 0)) {
    invalidState(`${name}.durability is invalid`);
  }
  requireRecord(product.metadata, `${name}.metadata`);
}

function validateJob(job, mapId) {
  requireRecord(job, 'craft job');
  requireRecordKeys(job, [
    'craftJobId', 'recipeId', 'actorId', 'sourceContainerId', 'outputContainerId', 'stationId',
    'status', 'queuedAt', 'startedAt', 'endsAt', 'completedAt', 'cancelledAt', 'durationMs',
    'quality', 'inputReservationIds', 'stationReservationId', 'inputReservations',
    'stationReservation', 'ingredients', 'tools', 'outputs', 'byproducts',
  ], 'craft job');
  for (const [name, value] of [
    ['craftJobId', job.craftJobId], ['recipeId', job.recipeId], ['actorId', job.actorId],
    ['sourceContainerId', job.sourceContainerId], ['outputContainerId', job.outputContainerId],
    ['stationId', job.stationId],
  ]) {
    requireStateId(value, name);
  }
  if (job.craftJobId !== mapId || !STATUS_SET.has(job.status)) {
    invalidState('craft job map key or status is invalid');
  }
  requireStateTimestamp(job.queuedAt, 'job.queuedAt');
  if (!Number.isSafeInteger(job.durationMs) || job.durationMs <= 0) {
    invalidState('job.durationMs must be a positive safe integer');
  }
  if (!Number.isInteger(job.quality) || job.quality < 0 || job.quality > 100) {
    invalidState('job.quality must be an integer from 0 through 100');
  }
  for (const name of ['inputReservationIds', 'inputReservations', 'ingredients', 'tools', 'outputs', 'byproducts']) {
    if (!Array.isArray(job[name])) invalidState(`job.${name} must be an array`);
  }
  if (job.inputReservationIds.length !== job.ingredients.length
      || job.inputReservations.length !== job.ingredients.length) {
    invalidState('job input reservations must correspond one-to-one with ingredients');
  }
  const reservationIds = new Set();
  for (let index = 0; index < job.inputReservationIds.length; index += 1) {
    const id = job.inputReservationIds[index];
    if (!isStableIdentifier(id) || reservationIds.has(id)) {
      invalidState('job input reservation IDs are invalid');
    }
    reservationIds.add(id);
    validateIngredient(job.ingredients[index], `job.ingredients[${index}]`);
    validateInputReservation(
      job.inputReservations[index], job.ingredients[index], job.craftJobId,
      `job.inputReservations[${index}]`,
    );
    if (job.inputReservations[index].reservationId !== id
        || job.inputReservations[index].containerId !== job.sourceContainerId) {
      invalidState('job input reservation identity or container is inconsistent');
    }
  }
  requireStateId(job.stationReservationId, 'job.stationReservationId');
  validateStationReservation(job.stationReservation, job, 'job.stationReservation');
  const toolIds = new Set();
  for (let index = 0; index < job.tools.length; index += 1) {
    validateTool(job.tools[index], `job.tools[${index}]`);
    if (toolIds.has(job.tools[index].itemId)) invalidState('job tool item IDs must be unique');
    toolIds.add(job.tools[index].itemId);
  }
  const productIds = new Set();
  for (const name of ['outputs', 'byproducts']) {
    if (name === 'outputs' && job[name].length === 0) invalidState('job.outputs must not be empty');
    for (let index = 0; index < job[name].length; index += 1) {
      validateProduct(job[name][index], `job.${name}[${index}]`);
      if (productIds.has(job[name][index].itemId)) invalidState('job product item IDs must be unique');
      productIds.add(job[name][index].itemId);
    }
  }
  const timestampFields = ['startedAt', 'endsAt', 'completedAt', 'cancelledAt'];
  for (const name of timestampFields) {
    if (job[name] !== null) requireStateTimestamp(job[name], `job.${name}`);
  }
  if (job.status === 'QUEUED' && timestampFields.some(name => job[name] !== null)) {
    invalidState('queued job timestamps are inconsistent');
  }
  const started = job.startedAt !== null;
  if (started) {
    const expectedEnd = job.startedAt + job.durationMs;
    if (job.startedAt < job.queuedAt || !Number.isSafeInteger(expectedEnd) || job.endsAt !== expectedEnd) {
      invalidState('job start/end chronology is inconsistent');
    }
  } else if (job.endsAt !== null) {
    invalidState('job start/end timestamps must be paired');
  }
  if (job.status === 'ACTIVE' && (!started || job.completedAt !== null || job.cancelledAt !== null)) {
    invalidState('active job timestamps are inconsistent');
  }
  if (job.status === 'COMPLETED' && (!started || job.completedAt === null
      || job.completedAt < job.endsAt || job.cancelledAt !== null)) {
    invalidState('completed job timestamps are inconsistent');
  }
  if (job.status === 'CANCELLED' && (job.cancelledAt === null || job.completedAt !== null
      || job.cancelledAt < (started ? job.startedAt : job.queuedAt))) {
    invalidState('cancelled job timestamps are inconsistent');
  }
}

const TRANSITION_PLAN_FIELDS = Object.freeze([
  'craftJobId', 'recipeId', 'actorId', 'sourceContainerId', 'outputContainerId', 'stationId',
  'queuedAt', 'durationMs', 'quality', 'inputReservationIds', 'stationReservationId',
  'inputReservations', 'stationReservation', 'ingredients', 'tools', 'outputs', 'byproducts',
]);

function requireSameJobPlan(currentJob, nextJob) {
  for (const field of TRANSITION_PLAN_FIELDS) {
    if (!inventoryInternals.structuralEqual(currentJob[field], nextJob[field])) {
      throw craftingError('craft.invalid_event', `craft job transition altered immutable field: ${field}`);
    }
  }
}

function requireLiveReservations(state, job) {
  for (const expected of job.inputReservations) {
    const live = Object.hasOwn(state.reservationsById, expected.reservationId)
      ? state.reservationsById[expected.reservationId] : undefined;
    if (!inventoryInternals.structuralEqual(live, expected)) {
      throw craftingError('craft.reservation_conflict', 'live input reservation does not match job generation', {
        reservationId: expected.reservationId,
      });
    }
  }
  const liveStation = Object.hasOwn(state.taskReservationsById, job.stationReservationId)
    ? state.taskReservationsById[job.stationReservationId] : undefined;
  if (!inventoryInternals.structuralEqual(liveStation, job.stationReservation)) {
    throw craftingError('craft.reservation_conflict', 'live station reservation does not match job generation', {
      reservationId: job.stationReservationId,
    });
  }
}

function validateTaskReservationMap(map) {
  try {
    return reserveTaskResources({ reservationsById: map }, {
      taskId: 'craft-validation', createdAt: 0, resources: [],
    }).reservationsById;
  } catch (error) {
    throw craftingError('craft.invalid_state', error.message);
  }
}

function validateState(state) {
  let current;
  try {
    current = inventoryInternals.validateState(state);
  } catch (error) {
    throw craftingError('craft.invalid_state', error.message);
  }
  for (const name of ['taskReservationsById', 'craftJobsById', 'stationsById']) {
    if (!current[name] || Array.isArray(current[name])
        || Object.getPrototypeOf(current[name]) !== Object.prototype) {
      throw craftingError('craft.invalid_state', `state.${name} must be a plain object map`);
    }
  }
  current.taskReservationsById = structuredClone(validateTaskReservationMap(current.taskReservationsById));
  for (const [id, job] of Object.entries(current.craftJobsById)) validateJob(job, id);
  for (const stationId of Object.keys(current.stationsById)) {
    if (!isStableIdentifier(stationId)) throw craftingError('craft.invalid_state', 'station map keys must be stable identifiers');
    recipeInternals.stationFor(current, stationId);
  }
  return current;
}

function requireFactory(context, name) {
  if (!context || Array.isArray(context) || Object.getPrototypeOf(context) !== Object.prototype) {
    throw craftingError('craft.invalid_context', 'context must be a plain object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(context, name);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function') {
    throw craftingError('craft.invalid_context', `${name} must be a function`);
  }
  return descriptor.value;
}

function requireDefinitions(context) {
  if (!context || Array.isArray(context) || Object.getPrototypeOf(context) !== Object.prototype) {
    throw craftingError('craft.invalid_context', 'context must be a plain object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(context, 'definitionsById');
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw craftingError('craft.invalid_context', 'definitionsById must be an enumerable data property');
  }
  const definitionsById = recipeInternals.immutableClone(
    descriptor.value, 'definitionsById', 'craft.invalid_context',
  );
  if (!definitionsById || Array.isArray(definitionsById)
      || Object.getPrototypeOf(definitionsById) !== Object.prototype) {
    throw craftingError('craft.invalid_context', 'definitionsById must be a plain object map');
  }
  return definitionsById;
}

function definitionFor(definitionsById, itemId) {
  return recipeInternals.definitionFor(definitionsById, itemId);
}

function getJob(state, craftJobId) {
  requireId(craftJobId, 'craftJobId');
  const job = Object.hasOwn(state.craftJobsById, craftJobId) ? state.craftJobsById[craftJobId] : undefined;
  if (!job) throw craftingError('craft.job_not_found', 'craft job does not exist', { craftJobId });
  return job;
}

function requireOwnerAndStation(job, input) {
  requireId(input.actorId, 'actorId');
  requireId(input.stationId, 'stationId');
  if (input.actorId !== job.actorId) throw craftingError('craft.wrong_actor', 'actor does not own craft job');
  if (input.stationId !== job.stationId) throw craftingError('craft.wrong_station', 'station does not match craft job');
}

function uniquePlaceholder(existing, prefix) {
  let suffix = 0;
  let candidate = prefix;
  while (Object.hasOwn(existing, candidate)) {
    suffix += 1;
    candidate = `${prefix}-${suffix}`;
  }
  return candidate;
}

function preflightReservations(state, match, queuedAt) {
  let inventoryState = state;
  const used = { ...state.reservationsById };
  for (const ingredient of match.ingredients) {
    const reservationId = uniquePlaceholder(used, 'craft-preflight-input');
    used[reservationId] = true;
    try {
      inventoryState = reserveQuantity(inventoryState, {
        reservationId,
        containerId: match.sourceContainerId,
        itemId: ingredient.itemId,
        quantity: ingredient.quantity,
      });
    } catch (error) {
      throw craftingError('craft.reservation_failed', error.message);
    }
  }
  const reservationId = uniquePlaceholder(state.taskReservationsById, 'craft-preflight-station');
  try {
    reserveTaskResources({ reservationsById: state.taskReservationsById }, {
      taskId: 'craft-preflight-job', createdAt: queuedAt,
      resources: [{ reservationId, resourceType: 'station', resourceId: match.stationId }],
    });
  } catch (error) {
    throw craftingError('craft.station_unavailable', error.message, { stationId: match.stationId });
  }
}

function validateOutputPlan(state, recipe, outputContainerId, definitionsById) {
  requireId(outputContainerId, 'outputContainerId');
  const container = Object.hasOwn(state.containersById, outputContainerId)
    ? state.containersById[outputContainerId] : undefined;
  if (!container) throw craftingError('craft.container_not_found', 'output container does not exist');
  const records = [...recipe.outputs, ...recipe.byproducts];
  for (const record of records) definitionFor(definitionsById, record.itemId);
  const occupied = container.stacks.reduce((sum, stack) => sum + stack.quantity, 0);
  const produced = records.reduce((sum, record) => sum + record.quantity, 0);
  if (occupied + produced > container.capacity) {
    throw craftingError('craft.output_capacity', 'output container lacks capacity', { outputContainerId });
  }
}

function productRecords(recipe, quality, definitionsById) {
  const build = (record, outputQuality) => {
    const definition = definitionFor(definitionsById, record.itemId);
    return {
      itemId: record.itemId,
      quantity: record.quantity,
      quality: outputQuality,
      durability: definition.durability.enabled ? definition.durability.max : null,
      metadata: {},
    };
  };
  return {
    outputs: recipe.outputs.map(record => build(record, quality)),
    byproducts: recipe.byproducts.map(record => build(record, null)),
  };
}

function immutableResult(state, job, event) {
  return Object.freeze({
    state: copyImmutableData(state, 'state'),
    job: copyImmutableData(job, 'job'),
    event: copyImmutableData(event, 'event'),
  });
}

function applyQueueFacts(state, payload) {
  let next = validateState(state);
  const facts = cloneInput(payload, 'event.payload');
  const job = cloneInput(facts?.job, 'event.payload.job');
  validateJob(job, job.craftJobId);
  if (job.status !== 'QUEUED') throw craftingError('craft.invalid_event', 'queue fact must contain a queued job');
  if (Object.hasOwn(next.craftJobsById, job.craftJobId)) {
    throw craftingError('craft.id_collision', 'craft job ID already exists', { craftJobId: job.craftJobId });
  }
  if (!Array.isArray(facts.inventoryReservations)
      || facts.inventoryReservations.length !== job.inputReservationIds.length) {
    throw craftingError('craft.invalid_event', 'queue facts contain invalid inventory reservations');
  }
  for (let index = 0; index < facts.inventoryReservations.length; index += 1) {
    const record = cloneInput(facts.inventoryReservations[index], 'inventory reservation');
    if (record.reservationId !== job.inputReservationIds[index]
        || !inventoryInternals.structuralEqual(record, job.inputReservations[index])
        || Object.hasOwn(next.reservationsById, record.reservationId)) {
      throw craftingError('craft.invalid_event', 'queue reservation facts do not match job');
    }
    next.reservationsById[record.reservationId] = record;
  }
  try {
    next = inventoryInternals.validateState(next);
  } catch (error) {
    throw craftingError('craft.invalid_event', error.message);
  }
  const station = cloneInput(facts.stationReservation, 'station reservation');
  if (station.reservationId !== job.stationReservationId || station.taskId !== job.craftJobId
      || station.resourceType !== 'station' || station.resourceId !== job.stationId
      || !inventoryInternals.structuralEqual(station, job.stationReservation)
      || Object.hasOwn(next.taskReservationsById, station.reservationId)
      || Object.values(next.taskReservationsById).some(record => record.resourceKey === station.resourceKey)) {
    throw craftingError('craft.invalid_event', 'station reservation fact does not match job');
  }
  next.taskReservationsById[station.reservationId] = station;
  next.taskReservationsById = structuredClone(validateTaskReservationMap(next.taskReservationsById));
  next.craftJobsById[job.craftJobId] = job;
  return copyImmutableData(next, 'state');
}

export function queueProduction(state, recipe, input, context) {
  const current = validateState(state);
  const normalizedRecipe = validateRecipe(recipe);
  const args = cloneInput(input);
  recipeInternals.requirePlainObject(args, 'input');
  for (const name of ['actorId', 'sourceContainerId', 'outputContainerId', 'stationId']) requireId(args[name], name);
  requireTimestamp(args.queuedAt, 'queuedAt');
  const definitionsById = requireDefinitions(context);
  const nextCraftJobId = requireFactory(context, 'nextCraftJobId');
  const nextReservationId = requireFactory(context, 'nextReservationId');
  const match = matchRecipeInputs(current, normalizedRecipe, {
    sourceContainerId: args.sourceContainerId, stationId: args.stationId,
  }, { definitionsById });
  validateOutputPlan(current, normalizedRecipe, args.outputContainerId, definitionsById);
  const quality = calculateQuality({
    skill: args.skill,
    difficulty: normalizedRecipe.difficulty,
    toolCondition: match.toolCondition,
    inputQuality: match.inputQuality,
    roll: args.roll,
  });
  preflightReservations(current, match, args.queuedAt);

  const craftJobId = nextCraftJobId();
  requireId(craftJobId, 'generated craftJobId');
  if (Object.hasOwn(current.craftJobsById, craftJobId)) {
    throw craftingError('craft.id_collision', 'generated craft job ID already exists', { craftJobId });
  }
  const generatedIds = [];
  for (let index = 0; index < match.ingredients.length + 1; index += 1) {
    const id = nextReservationId();
    requireId(id, 'generated reservationId');
    if (generatedIds.includes(id)
        || Object.hasOwn(current.reservationsById, id)
        || Object.hasOwn(current.taskReservationsById, id)) {
      throw craftingError('craft.id_collision', 'generated reservation ID already exists', { reservationId: id });
    }
    generatedIds.push(id);
  }
  const inputReservationIds = generatedIds.slice(0, -1);
  const stationReservationId = generatedIds.at(-1);
  let reserved = current;
  const reservationRecords = [];
  for (let index = 0; index < match.ingredients.length; index += 1) {
    const ingredient = match.ingredients[index];
    try {
      reserved = reserveQuantity(reserved, {
        reservationId: inputReservationIds[index], containerId: args.sourceContainerId,
        itemId: ingredient.itemId, quantity: ingredient.quantity,
      });
    } catch (error) {
      throw craftingError('craft.reservation_failed', error.message);
    }
    const record = {
      ...reserved.reservationsById[inputReservationIds[index]], craftJobId,
    };
    reserved.reservationsById[inputReservationIds[index]] = record;
    reservationRecords.push(record);
  }
  let taskState;
  try {
    taskState = reserveTaskResources({ reservationsById: reserved.taskReservationsById }, {
      taskId: craftJobId, createdAt: args.queuedAt,
      resources: [{ reservationId: stationReservationId, resourceType: 'station', resourceId: args.stationId }],
    });
  } catch (error) {
    throw craftingError('craft.station_unavailable', error.message, { stationId: args.stationId });
  }
  const products = productRecords(normalizedRecipe, quality, definitionsById);
  const stationReservation = {
    ...taskState.reservationsById[stationReservationId], craftJobId,
  };
  const job = copyImmutableData({
    craftJobId,
    recipeId: normalizedRecipe.recipeId,
    actorId: args.actorId,
    sourceContainerId: args.sourceContainerId,
    outputContainerId: args.outputContainerId,
    stationId: args.stationId,
    status: 'QUEUED',
    queuedAt: args.queuedAt,
    startedAt: null,
    endsAt: null,
    completedAt: null,
    cancelledAt: null,
    durationMs: normalizedRecipe.durationMs,
    quality,
    inputReservationIds,
    stationReservationId,
    inputReservations: reservationRecords,
    stationReservation,
    ingredients: match.ingredients,
    tools: match.tools,
    outputs: products.outputs,
    byproducts: products.byproducts,
  }, 'job');
  const payload = copyImmutableData({ job, inventoryReservations: reservationRecords, stationReservation }, 'queue event payload');
  const next = applyQueueFacts(current, payload);
  return immutableResult(next, job, { type: 'craft.queued', payload });
}

function applyStartFacts(state, payload) {
  const next = validateState(state);
  const facts = cloneInput(payload, 'event.payload');
  const job = cloneInput(facts?.job, 'event.payload.job');
  validateJob(job, job.craftJobId);
  const currentJob = getJob(next, job.craftJobId);
  if (currentJob.status !== 'QUEUED' || job.status !== 'ACTIVE') {
    throw craftingError('craft.invalid_transition', 'start fact must transition QUEUED to ACTIVE');
  }
  requireSameJobPlan(currentJob, job);
  requireLiveReservations(next, currentJob);
  next.craftJobsById[job.craftJobId] = job;
  return copyImmutableData(next, 'state');
}

export function startProduction(state, craftJobId, input, _context) {
  const current = validateState(state);
  const job = getJob(current, craftJobId);
  const args = cloneInput(input);
  recipeInternals.requirePlainObject(args, 'input');
  requireOwnerAndStation(job, args);
  if (job.status !== 'QUEUED') throw craftingError('craft.invalid_transition', 'only queued jobs can start');
  requireLiveReservations(current, job);
  requireTimestamp(args.startedAt, 'startedAt');
  if (args.startedAt < job.queuedAt) throw craftingError('craft.invalid_time', 'startedAt must not precede queuedAt');
  const endsAt = args.startedAt + job.durationMs;
  if (!Number.isSafeInteger(endsAt)) throw craftingError('craft.invalid_time', 'job end time exceeds the safe integer range');
  const started = copyImmutableData({ ...job, status: 'ACTIVE', startedAt: args.startedAt, endsAt }, 'job');
  const payload = copyImmutableData({ job: started }, 'start event payload');
  return immutableResult(applyStartFacts(current, payload), started, { type: 'craft.started', payload });
}

function outputAddition(state, job, product, definitionsById, nextStackId) {
  const generated = [];
  const beforeStacks = cloneInput(
    state.containersById[job.outputContainerId].stacks, 'output stacks before addition',
  );
  let next;
  try {
    next = addItem(state, {
      containerId: job.outputContainerId,
      itemId: product.itemId,
      quantity: product.quantity,
      quality: product.quality,
      durability: product.durability,
      metadata: product.metadata,
      definition: definitionFor(definitionsById, product.itemId),
      definitionsById,
      nextStackId() {
        const id = nextStackId();
        generated.push(id);
        return id;
      },
    });
  } catch (error) {
    if (error instanceof CraftingError) throw error;
    throw craftingError('craft.output_failed', error.message);
  }
  return {
    state: next,
    addition: copyImmutableData({
      ...product,
      stackIds: generated,
      beforeStacks,
      afterStacks: next.containersById[job.outputContainerId].stacks,
    }, 'output addition'),
  };
}

function stackMatchesProduct(stack, product) {
  return stack.itemId === product.itemId
    && stack.quality === product.quality
    && stack.durability === product.durability
    && inventoryInternals.structuralEqual(stack.metadata, product.metadata);
}

function applyOutputPlacement(state, job, addition, expected) {
  for (const name of ['itemId', 'quantity', 'quality', 'durability']) {
    if (addition[name] !== expected[name]) {
      throw craftingError('craft.invalid_event', 'completion output fact does not match job');
    }
  }
  if (!inventoryInternals.structuralEqual(addition.metadata, expected.metadata)
      || !Array.isArray(addition.stackIds)
      || !Array.isArray(addition.beforeStacks)
      || !Array.isArray(addition.afterStacks)) {
    throw craftingError('craft.invalid_event', 'completion output placement is malformed');
  }
  const container = state.containersById[job.outputContainerId];
  if (!container || !inventoryInternals.structuralEqual(container.stacks, addition.beforeStacks)) {
    throw craftingError('craft.invalid_event', 'completion output placement precondition does not match state');
  }
  const generatedIds = new Set();
  for (const id of addition.stackIds) {
    if (!isStableIdentifier(id) || generatedIds.has(id)) {
      throw craftingError('craft.invalid_event', 'completion output IDs must be unique stable identifiers');
    }
    generatedIds.add(id);
  }
  const beforeById = new Map(addition.beforeStacks.map(stack => [stack.stackId, stack]));
  if (addition.beforeStacks.some((stack, index) => addition.afterStacks[index]?.stackId !== stack.stackId)) {
    throw craftingError('craft.invalid_event', 'completion placement must preserve every existing output stack');
  }
  const newIds = [];
  let addedQuantity = 0;
  for (let index = 0; index < addition.afterStacks.length; index += 1) {
    const after = addition.afterStacks[index];
    const before = beforeById.get(after.stackId);
    if (!before) {
      newIds.push(after.stackId);
      if (!stackMatchesProduct(after, expected)) {
        throw craftingError('craft.invalid_event', 'new output stack traits do not match recorded product');
      }
      addedQuantity += after.quantity;
      continue;
    }
    const beforeIndex = addition.beforeStacks.findIndex(stack => stack.stackId === after.stackId);
    if (beforeIndex !== index
        || after.quantity < before.quantity
        || after.itemId !== before.itemId
        || after.quality !== before.quality
        || after.durability !== before.durability
        || !inventoryInternals.structuralEqual(after.metadata, before.metadata)) {
      throw craftingError('craft.invalid_event', 'existing output stack placement was altered invalidly');
    }
    const increase = after.quantity - before.quantity;
    if (increase > 0 && !stackMatchesProduct(after, expected)) {
      throw craftingError('craft.invalid_event', 'output was added to an incompatible existing stack');
    }
    addedQuantity += increase;
  }
  if (addition.afterStacks.length < addition.beforeStacks.length
      || newIds.length !== addition.stackIds.length
      || newIds.some((id, index) => id !== addition.stackIds[index])
      || addedQuantity !== expected.quantity) {
    throw craftingError('craft.invalid_event', 'completion placement does not consume exact product quantity and IDs');
  }
  const next = structuredClone(state);
  next.containersById[job.outputContainerId].stacks = structuredClone(addition.afterStacks);
  try {
    return inventoryInternals.validateState(next);
  } catch (error) {
    throw craftingError('craft.invalid_event', error.message);
  }
}

function preflightCompletionPlan(state, job, definitionsById) {
  const products = [...job.outputs, ...job.byproducts];
  for (const product of products) definitionFor(definitionsById, product.itemId);
  const container = state.containersById[job.outputContainerId];
  if (!container) throw craftingError('craft.container_not_found', 'output container does not exist');
  let total = container.stacks.reduce((sum, stack) => sum + stack.quantity, 0);
  for (const product of products) {
    total += product.quantity;
    if (!Number.isSafeInteger(total) || total > container.capacity) {
      throw craftingError('craft.output_capacity', 'output container lacks capacity for the complete production plan', {
        outputContainerId: job.outputContainerId,
      });
    }
  }
}

function applyCompletionFacts(state, payload) {
  let next = validateState(state);
  const facts = cloneInput(payload, 'event.payload');
  const job = cloneInput(facts?.job, 'event.payload.job');
  validateJob(job, job.craftJobId);
  if (job.status !== 'COMPLETED') throw craftingError('craft.invalid_event', 'completion fact must contain a completed job');
  const currentJob = getJob(next, job.craftJobId);
  if (currentJob.status !== 'ACTIVE') throw craftingError('craft.invalid_transition', 'only active jobs can complete');
  requireSameJobPlan(currentJob, job);
  requireLiveReservations(next, currentJob);
  if (!Array.isArray(facts.consumedReservationIds)
      || facts.consumedReservationIds.length !== currentJob.inputReservationIds.length
      || facts.consumedReservationIds.some((id, index) => id !== currentJob.inputReservationIds[index])) {
    throw craftingError('craft.invalid_event', 'completion reservation facts do not match job');
  }
  try {
    for (const id of facts.consumedReservationIds) next = consumeReservation(next, id);
  } catch (error) {
    throw craftingError('craft.reservation_failed', error.message);
  }
  if (facts.releasedStationReservationId !== currentJob.stationReservationId) {
    throw craftingError('craft.invalid_event', 'completion station fact does not match job');
  }
  try {
    const released = releaseTaskResources({ reservationsById: next.taskReservationsById }, {
      taskId: currentJob.craftJobId, reservationIds: [facts.releasedStationReservationId],
    });
    next.taskReservationsById = structuredClone(released.reservationsById);
  } catch (error) {
    throw craftingError('craft.station_unavailable', error.message);
  }
  if (!Array.isArray(facts.additions)
      || facts.additions.length !== currentJob.outputs.length + currentJob.byproducts.length) {
    throw craftingError('craft.invalid_event', 'completion additions do not match job');
  }
  const expectedProducts = [...currentJob.outputs, ...currentJob.byproducts];
  for (let index = 0; index < facts.additions.length; index += 1) {
    const addition = facts.additions[index];
    const expected = expectedProducts[index];
    for (const name of ['itemId', 'quantity', 'quality', 'durability']) {
      if (addition[name] !== expected[name]) throw craftingError('craft.invalid_event', 'completion output fact does not match job');
    }
    next = applyOutputPlacement(next, currentJob, addition, expected);
  }
  next.craftJobsById[job.craftJobId] = job;
  return copyImmutableData(next, 'state');
}

export function completeProduction(state, craftJobId, input, context) {
  const current = validateState(state);
  const job = getJob(current, craftJobId);
  const args = cloneInput(input);
  recipeInternals.requirePlainObject(args, 'input');
  requireOwnerAndStation(job, args);
  if (job.status !== 'ACTIVE') throw craftingError('craft.invalid_transition', 'only active jobs can complete');
  requireLiveReservations(current, job);
  requireTimestamp(args.completedAt, 'completedAt');
  if (args.completedAt < job.startedAt || args.completedAt < job.endsAt) {
    throw craftingError('craft.invalid_time', 'completedAt must be at or after endsAt');
  }
  const definitionsById = requireDefinitions(context);
  const nextStackId = requireFactory(context, 'nextStackId');
  let preview = current;
  try {
    for (const id of job.inputReservationIds) preview = consumeReservation(preview, id);
    const released = releaseTaskResources({ reservationsById: preview.taskReservationsById }, {
      taskId: job.craftJobId, reservationIds: [job.stationReservationId],
    });
    preview.taskReservationsById = structuredClone(released.reservationsById);
  } catch (error) {
    throw craftingError('craft.reservation_failed', error.message);
  }
  preflightCompletionPlan(preview, job, definitionsById);
  const additions = [];
  for (const product of [...job.outputs, ...job.byproducts]) {
    const result = outputAddition(preview, job, product, definitionsById, nextStackId);
    preview = result.state;
    additions.push(result.addition);
  }
  const completed = copyImmutableData({ ...job, status: 'COMPLETED', completedAt: args.completedAt }, 'job');
  const payload = copyImmutableData({
    job: completed,
    consumedReservationIds: job.inputReservationIds,
    releasedStationReservationId: job.stationReservationId,
    additions,
  }, 'completion event payload');
  return immutableResult(applyCompletionFacts(current, payload), completed, {
    type: 'craft.completed', payload,
  });
}

function applyCancellationFacts(state, payload) {
  let next = validateState(state);
  const facts = cloneInput(payload, 'event.payload');
  const job = cloneInput(facts?.job, 'event.payload.job');
  validateJob(job, job.craftJobId);
  if (job.status !== 'CANCELLED') throw craftingError('craft.invalid_event', 'cancellation fact must contain a cancelled job');
  const currentJob = getJob(next, job.craftJobId);
  if (!['QUEUED', 'ACTIVE'].includes(currentJob.status)) {
    throw craftingError('craft.invalid_transition', 'only queued or active jobs can be cancelled');
  }
  requireSameJobPlan(currentJob, job);
  requireLiveReservations(next, currentJob);
  if (!Array.isArray(facts.releasedReservationIds)
      || facts.releasedReservationIds.length !== currentJob.inputReservationIds.length
      || facts.releasedReservationIds.some((id, index) => id !== currentJob.inputReservationIds[index])) {
    throw craftingError('craft.invalid_event', 'cancellation reservation facts do not match job');
  }
  if (facts.releasedStationReservationId !== currentJob.stationReservationId) {
    throw craftingError('craft.invalid_event', 'cancellation station fact does not match job');
  }
  try {
    for (const id of facts.releasedReservationIds) next = releaseReservation(next, id);
    const released = releaseTaskResources({ reservationsById: next.taskReservationsById }, {
      taskId: currentJob.craftJobId, reservationIds: [facts.releasedStationReservationId],
    });
    next.taskReservationsById = structuredClone(released.reservationsById);
  } catch (error) {
    throw craftingError('craft.reservation_failed', error.message);
  }
  next.craftJobsById[job.craftJobId] = job;
  return copyImmutableData(next, 'state');
}

export function cancelProduction(state, craftJobId, input, _context) {
  const current = validateState(state);
  const job = getJob(current, craftJobId);
  const args = cloneInput(input);
  recipeInternals.requirePlainObject(args, 'input');
  requireOwnerAndStation(job, args);
  if (!['QUEUED', 'ACTIVE'].includes(job.status)) {
    throw craftingError('craft.invalid_transition', 'only queued or active jobs can be cancelled');
  }
  requireLiveReservations(current, job);
  requireTimestamp(args.cancelledAt, 'cancelledAt');
  const boundary = job.status === 'ACTIVE' ? job.startedAt : job.queuedAt;
  if (args.cancelledAt < boundary) throw craftingError('craft.invalid_time', 'cancelledAt is backward');
  const cancelled = copyImmutableData({ ...job, status: 'CANCELLED', cancelledAt: args.cancelledAt }, 'job');
  const payload = copyImmutableData({
    job: cancelled,
    releasedReservationIds: job.inputReservationIds,
    releasedStationReservationId: job.stationReservationId,
  }, 'cancellation event payload');
  return immutableResult(applyCancellationFacts(current, payload), cancelled, {
    type: 'craft.cancelled', payload,
  });
}

function requireHandlerOptions(options) {
  if (!options || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype) {
    throw craftingError('craft.invalid_context', 'options must be a plain object');
  }
  const allowed = new Set([
    'definitionsById', 'recipesById', 'nextCraftJobId', 'nextReservationId', 'nextStackId',
  ]);
  const values = {};
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (typeof key !== 'string' || !allowed.has(key) || !descriptor?.enumerable
        || !Object.hasOwn(descriptor, 'value')) {
      throw craftingError('craft.invalid_context', 'options must contain only documented enumerable data properties');
    }
    values[key] = descriptor.value;
  }
  const definitionsById = requireDefinitions(options);
  const recipesByIdInput = recipeInternals.immutableClone(
    values.recipesById, 'recipesById', 'craft.invalid_context',
  );
  if (!recipesByIdInput || Array.isArray(recipesByIdInput)
      || Object.getPrototypeOf(recipesByIdInput) !== Object.prototype) {
    throw craftingError('craft.invalid_context', 'recipesById must be a plain object map');
  }
  for (const name of ['nextCraftJobId', 'nextReservationId', 'nextStackId']) {
    if (typeof values[name] !== 'function') {
      throw craftingError('craft.invalid_context', `${name} must be a function`);
    }
  }
  const recipesById = {};
  for (const [id, recipe] of Object.entries(recipesByIdInput)) {
    const normalized = validateRecipe(recipe);
    if (id !== normalized.recipeId) {
      throw craftingError('craft.invalid_context', 'recipe map key must match recipeId');
    }
    recipesById[id] = normalized;
  }
  return {
    definitionsById,
    recipesById: copyImmutableData(recipesById, 'recipesById'),
    nextCraftJobId: values.nextCraftJobId,
    nextReservationId: values.nextReservationId,
    nextStackId: values.nextStackId,
  };
}

function rejectCrafting(operation) {
  return (state, command, context) => {
    try {
      return operation(state, command, context);
    } catch (error) {
      if (error instanceof CraftingError || error?.code?.startsWith?.('craft.')) {
        return reject(error.code, error.message, error.details ?? {});
      }
      return reject('craft.invalid_operation', error?.message ?? 'craft operation failed', {});
    }
  };
}

export function createCraftingHandlers(options) {
  const {
    definitionsById, recipesById, nextCraftJobId, nextReservationId, nextStackId,
  } = requireHandlerOptions(options);
  const queueContext = {
    definitionsById,
    nextCraftJobId,
    nextReservationId,
  };
  return {
    'craft.queue': {
      decide: rejectCrafting((state, command, context) => {
        const recipe = Object.hasOwn(recipesById, command.payload.recipeId)
          ? recipesById[command.payload.recipeId] : undefined;
        if (!recipe) throw craftingError('craft.recipe_not_found', 'recipe does not exist', { recipeId: command.payload.recipeId });
        const result = queueProduction(state, recipe, { ...command.payload, actorId: command.actorId }, queueContext);
        return accept([context.createEvent(result.event.type, result.event.payload)]);
      }),
      reduce: (state, event) => applyQueueFacts(state, event.payload),
    },
    'craft.start': {
      decide: rejectCrafting((state, command, context) => {
        const result = startProduction(state, command.payload.craftJobId, {
          ...command.payload, actorId: command.actorId,
        }, {});
        return accept([context.createEvent(result.event.type, result.event.payload)]);
      }),
      reduce: (state, event) => applyStartFacts(state, event.payload),
    },
    'craft.complete': {
      decide: rejectCrafting((state, command, context) => {
        const result = completeProduction(state, command.payload.craftJobId, {
          ...command.payload, actorId: command.actorId,
        }, { definitionsById, nextStackId });
        return accept([context.createEvent(result.event.type, result.event.payload)]);
      }),
      reduce: (state, event) => applyCompletionFacts(state, event.payload),
    },
    'craft.cancel': {
      decide: rejectCrafting((state, command, context) => {
        const result = cancelProduction(state, command.payload.craftJobId, {
          ...command.payload, actorId: command.actorId,
        }, {});
        return accept([context.createEvent(result.event.type, result.event.payload)]);
      }),
      reduce: (state, event) => applyCancellationFacts(state, event.payload),
    },
  };
}

export const productionInternals = Object.freeze({
  applyCancellationFacts,
  applyCompletionFacts,
  applyQueueFacts,
  validateState,
});
