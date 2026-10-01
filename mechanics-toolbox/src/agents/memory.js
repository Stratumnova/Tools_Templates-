import { copyImmutableData } from '../core/immutable-data.js';
import { requireStableIdentifier } from '../core/identifiers.js';

const OBSERVATION_KEYS = Object.freeze([
  'memoryId',
  'kind',
  'subjectId',
  'sequence',
  'salience',
  'data',
]);

function requireExactKeys(value, keys, name) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unsupported or missing fields`);
  }
}

function validateCapacity(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000) {
    throw new TypeError('capacity must be a safe integer from 1 through 1000');
  }
  return capacity;
}

function validateObservation(observation, name = 'observation') {
  const copy = copyImmutableData(observation, name);
  if (copy === null || Array.isArray(copy) || Object.getPrototypeOf(copy) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  requireExactKeys(copy, OBSERVATION_KEYS, name);
  requireStableIdentifier(copy.memoryId, `${name}.memoryId`);
  requireStableIdentifier(copy.kind, `${name}.kind`);
  requireStableIdentifier(copy.subjectId, `${name}.subjectId`);
  if (!Number.isSafeInteger(copy.sequence) || copy.sequence < 0) {
    throw new TypeError(`${name}.sequence must be a nonnegative safe integer`);
  }
  if (!Number.isSafeInteger(copy.salience) || copy.salience < 0) {
    throw new TypeError(`${name}.salience must be a nonnegative safe integer`);
  }
  if (copy.data === null || Array.isArray(copy.data)
      || Object.getPrototypeOf(copy.data) !== Object.prototype) {
    throw new TypeError(`${name}.data must be a plain object`);
  }
  return copy;
}

function validateMemory(memory) {
  const copy = copyImmutableData(memory, 'memory');
  if (copy === null || Array.isArray(copy) || Object.getPrototypeOf(copy) !== Object.prototype) {
    throw new TypeError('memory must be a plain object');
  }
  requireExactKeys(copy, ['capacity', 'observations'], 'memory');
  validateCapacity(copy.capacity);
  if (!Array.isArray(copy.observations) || copy.observations.length > copy.capacity) {
    throw new TypeError('memory.observations must fit within capacity');
  }
  const seen = new Set();
  const observations = copy.observations.map((entry, index) => {
    const validated = validateObservation(entry, `memory.observations[${index}]`);
    if (seen.has(validated.memoryId)) throw new TypeError('memory contains duplicate memory IDs');
    seen.add(validated.memoryId);
    return validated;
  });
  return Object.freeze({ capacity: copy.capacity, observations: Object.freeze(observations) });
}

export function createAgentMemory(capacity) {
  return Object.freeze({ capacity: validateCapacity(capacity), observations: Object.freeze([]) });
}

export function rememberObservation(memory, observation) {
  const current = validateMemory(memory);
  const next = validateObservation(observation);
  if (current.observations.some((entry) => entry.memoryId === next.memoryId)) {
    throw new TypeError(`duplicate memory ID ${next.memoryId}`);
  }

  const observations = [...current.observations, next];
  if (observations.length > current.capacity) {
    const eviction = [...observations].sort((left, right) => (
      left.salience - right.salience
      || left.sequence - right.sequence
      || left.memoryId.localeCompare(right.memoryId)
    ))[0];
    observations.splice(observations.findIndex((entry) => entry.memoryId === eviction.memoryId), 1);
  }
  return Object.freeze({
    capacity: current.capacity,
    observations: Object.freeze(observations),
  });
}
