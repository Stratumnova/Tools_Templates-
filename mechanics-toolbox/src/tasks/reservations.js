import { requireStableIdentifier } from '../core/identifiers.js';
import { copyImmutableData } from '../core/immutable-data.js';
import { clockInternals } from '../time/clock.js';

const RESOURCE_TYPES = new Set(['worker', 'station', 'route', 'target']);

function stateCopy(state) {
  if (!state || Array.isArray(state) || Object.getPrototypeOf(state) !== Object.prototype
      || !state.reservationsById || Array.isArray(state.reservationsById)
      || Object.getPrototypeOf(state.reservationsById) !== Object.prototype) {
    throw new TypeError('state must contain a plain reservationsById map');
  }
  const copy = copyImmutableData(state, 'state');
  const keys = new Set();
  for (const [id, reservation] of Object.entries(copy.reservationsById)) {
    if (!reservation || reservation.reservationId !== id) throw new TypeError('reservation state is invalid');
    requireStableIdentifier(id, 'reservationId');
    requireStableIdentifier(reservation.taskId, 'taskId');
    requireStableIdentifier(reservation.resourceId, 'resourceId');
    if (!RESOURCE_TYPES.has(reservation.resourceType)
        || reservation.resourceKey !== `${reservation.resourceType}:${reservation.resourceId}`
        || keys.has(reservation.resourceKey)) throw new TypeError('reservation state is invalid');
    clockInternals.requireTimestamp(reservation.createdAt, 'createdAt');
    keys.add(reservation.resourceKey);
  }
  return structuredClone(copy);
}

export function reserveTaskResources(state, input) {
  const next = stateCopy(state);
  requireStableIdentifier(input?.taskId, 'taskId');
  clockInternals.requireTimestamp(input?.createdAt, 'createdAt');
  if (!Array.isArray(input?.resources)) throw new TypeError('resources must be an array');
  const ids = new Set(Object.keys(next.reservationsById));
  const keys = new Set(Object.values(next.reservationsById).map(value => value.resourceKey));
  const additions = [];
  for (const resource of input.resources) {
    requireStableIdentifier(resource?.reservationId, 'reservationId');
    requireStableIdentifier(resource?.resourceId, 'resourceId');
    if (!RESOURCE_TYPES.has(resource?.resourceType)) throw new TypeError('resourceType is invalid');
    const resourceKey = `${resource.resourceType}:${resource.resourceId}`;
    if (ids.has(resource.reservationId)) throw new RangeError('reservation ID already exists');
    if (keys.has(resourceKey)) throw new RangeError('resource is already reserved');
    ids.add(resource.reservationId); keys.add(resourceKey);
    additions.push({ reservationId: resource.reservationId, taskId: input.taskId,
      resourceType: resource.resourceType, resourceId: resource.resourceId,
      resourceKey, createdAt: input.createdAt });
  }
  for (const record of additions) next.reservationsById[record.reservationId] = record;
  return copyImmutableData(next, 'state');
}

export function releaseTaskResources(state, input) {
  const next = stateCopy(state);
  requireStableIdentifier(input?.taskId, 'taskId');
  if (!Array.isArray(input?.reservationIds) || input.reservationIds.length === 0) {
    throw new TypeError('reservationIds must be a non-empty array');
  }
  const ids = new Set();
  for (const id of input.reservationIds) {
    requireStableIdentifier(id, 'reservationId');
    if (ids.has(id)) throw new RangeError('reservation IDs must be unique');
    ids.add(id);
    if (!Object.hasOwn(next.reservationsById, id)) throw new RangeError('reservation does not exist');
    if (next.reservationsById[id].taskId !== input.taskId) throw new RangeError('task does not own reservation');
  }
  for (const id of ids) delete next.reservationsById[id];
  return copyImmutableData(next, 'state');
}
