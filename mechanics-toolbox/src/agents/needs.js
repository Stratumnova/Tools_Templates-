import { copyImmutableData } from '../core/immutable-data.js';
import { requireStableIdentifier } from '../core/identifiers.js';

const DEFINITION_KEYS = Object.freeze([
  'needId',
  'minimum',
  'maximum',
  'initial',
  'interval',
  'decayPerInterval',
  'weight',
  'urgencyPoints',
]);
const STATE_KEYS = Object.freeze(['needId', 'value', 'lastSequence', 'appliedIntervals']);

function requireExactKeys(value, keys, name) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} must contain exactly ${keys.join(', ')}`);
  }
}

function requireSafeInteger(value, name, { minimum, positive = false } = {}) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  if (positive && value <= 0) throw new TypeError(`${name} must be positive`);
  if (minimum !== undefined && value < minimum) {
    throw new TypeError(`${name} must be at least ${minimum}`);
  }
  return value;
}

function validateUrgencyPoints(points, minimum, maximum) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new TypeError('definition.urgencyPoints must be a non-empty array');
  }
  let previousValue;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (Object.getPrototypeOf(point) !== Object.prototype) {
      throw new TypeError(`definition.urgencyPoints[${index}] must be a plain object`);
    }
    requireExactKeys(point, ['value', 'urgency'], `definition.urgencyPoints[${index}]`);
    requireSafeInteger(point.value, `definition.urgencyPoints[${index}].value`);
    requireSafeInteger(point.urgency, `definition.urgencyPoints[${index}].urgency`, { minimum: 0 });
    if (point.value < minimum || point.value > maximum) {
      throw new TypeError(`definition.urgencyPoints[${index}].value is outside the need range`);
    }
    if (previousValue !== undefined && point.value <= previousValue) {
      throw new TypeError('definition.urgencyPoints values must be strictly increasing');
    }
    previousValue = point.value;
  }
}

export function validateNeedDefinition(definition) {
  const copy = copyImmutableData(definition, 'definition');
  if (Object.getPrototypeOf(copy) !== Object.prototype) {
    throw new TypeError('definition must be a plain object');
  }
  requireExactKeys(copy, DEFINITION_KEYS, 'definition');
  requireStableIdentifier(copy.needId, 'definition.needId');
  requireSafeInteger(copy.minimum, 'definition.minimum');
  requireSafeInteger(copy.maximum, 'definition.maximum');
  requireSafeInteger(copy.initial, 'definition.initial');
  requireSafeInteger(copy.interval, 'definition.interval', { positive: true });
  requireSafeInteger(copy.decayPerInterval, 'definition.decayPerInterval', { minimum: 0 });
  requireSafeInteger(copy.weight, 'definition.weight', { positive: true });
  if (copy.minimum > copy.maximum) throw new TypeError('definition.minimum must not exceed maximum');
  if (copy.initial < copy.minimum || copy.initial > copy.maximum) {
    throw new TypeError('definition.initial must be within the need range');
  }
  validateUrgencyPoints(copy.urgencyPoints, copy.minimum, copy.maximum);
  return copy;
}

function validateNeedState(needState, definition) {
  const state = copyImmutableData(needState, 'needState');
  requireExactKeys(state, STATE_KEYS, 'needState');
  requireStableIdentifier(state.needId, 'needState.needId');
  if (state.needId !== definition.needId) throw new TypeError('needState.needId must match definition.needId');
  requireSafeInteger(state.value, 'needState.value');
  requireSafeInteger(state.lastSequence, 'needState.lastSequence', { minimum: 0 });
  requireSafeInteger(state.appliedIntervals, 'needState.appliedIntervals', { minimum: 0 });
  if (state.value < definition.minimum || state.value > definition.maximum) {
    throw new TypeError('needState.value must be within the need range');
  }
  return state;
}

export function createNeedState(definition, sequence) {
  const validated = validateNeedDefinition(definition);
  requireSafeInteger(sequence, 'sequence', { minimum: 0 });
  return Object.freeze({
    needId: validated.needId,
    value: validated.initial,
    lastSequence: sequence,
    appliedIntervals: 0,
  });
}

export function advanceNeed(needState, definition, targetSequence) {
  const validated = validateNeedDefinition(definition);
  const state = validateNeedState(needState, validated);
  requireSafeInteger(targetSequence, 'targetSequence', { minimum: 0 });
  if (targetSequence < state.lastSequence) {
    throw new TypeError('targetSequence must not precede needState.lastSequence');
  }

  const elapsed = targetSequence - state.lastSequence;
  if (!Number.isSafeInteger(elapsed)) throw new TypeError('elapsed sequence must be a safe integer');
  const intervals = Math.floor(elapsed / validated.interval);
  if (intervals === 0) return state;

  const appliedIntervals = state.appliedIntervals + intervals;
  const consumedSequence = intervals * validated.interval;
  const totalDecay = intervals * validated.decayPerInterval;
  if (![appliedIntervals, consumedSequence, totalDecay].every(Number.isSafeInteger)) {
    throw new TypeError('need advancement exceeds safe integer range');
  }
  const lastSequence = state.lastSequence + consumedSequence;
  if (!Number.isSafeInteger(lastSequence)) throw new TypeError('need sequence exceeds safe integer range');
  const decayedValue = state.value - totalDecay;
  if (!Number.isSafeInteger(decayedValue)) {
    throw new TypeError('need value exceeds safe integer range');
  }

  return Object.freeze({
    needId: state.needId,
    value: Math.max(validated.minimum, decayedValue),
    lastSequence,
    appliedIntervals,
  });
}
