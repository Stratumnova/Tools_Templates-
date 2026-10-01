import { copyImmutableData } from '../core/immutable-data.js';
import { requireStableIdentifier } from '../core/identifiers.js';
import { validateRoleSet } from './skills.js';

const KEYS = Object.freeze([
  'routineId',
  'enabled',
  'period',
  'startOffset',
  'duration',
  'priority',
  'requiredRoleIds',
  'commandTemplate',
]);

function requireExactKeys(value, keys, name) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unsupported or missing fields`);
  }
}

function safeInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

export function validateRoutineDefinition(definition) {
  const copy = copyImmutableData(definition, 'definition');
  if (copy === null || Array.isArray(copy) || Object.getPrototypeOf(copy) !== Object.prototype) {
    throw new TypeError('definition must be a plain object');
  }
  requireExactKeys(copy, KEYS, 'definition');
  requireStableIdentifier(copy.routineId, 'definition.routineId');
  if (typeof copy.enabled !== 'boolean') throw new TypeError('definition.enabled must be boolean');
  safeInteger(copy.period, 'definition.period', 1);
  safeInteger(copy.startOffset, 'definition.startOffset');
  safeInteger(copy.duration, 'definition.duration', 1);
  safeInteger(copy.priority, 'definition.priority');
  if (copy.startOffset >= copy.period) throw new TypeError('definition.startOffset must be below period');
  const endOffset = copy.startOffset + copy.duration;
  if (!Number.isSafeInteger(endOffset) || endOffset > copy.period) {
    throw new TypeError('definition routine window must not wrap');
  }
  validateRoleSet(copy.requiredRoleIds);
  if (copy.commandTemplate === null || Array.isArray(copy.commandTemplate)
      || Object.getPrototypeOf(copy.commandTemplate) !== Object.prototype) {
    throw new TypeError('definition.commandTemplate must be a plain object');
  }
  requireExactKeys(copy.commandTemplate, ['type', 'payload'], 'definition.commandTemplate');
  requireStableIdentifier(copy.commandTemplate.type, 'definition.commandTemplate.type');
  if (copy.commandTemplate.payload === null || Array.isArray(copy.commandTemplate.payload)
      || Object.getPrototypeOf(copy.commandTemplate.payload) !== Object.prototype) {
    throw new TypeError('definition.commandTemplate.payload must be a plain object');
  }
  return copy;
}

export function eligibleRoutineCandidates(definitions, sequence, context) {
  const copiedDefinitions = copyImmutableData(definitions, 'definitions');
  if (!Array.isArray(copiedDefinitions)) throw new TypeError('definitions must be an array');
  safeInteger(sequence, 'sequence');
  const copiedContext = copyImmutableData(context, 'context');
  if (copiedContext === null || Array.isArray(copiedContext)
      || Object.getPrototypeOf(copiedContext) !== Object.prototype) {
    throw new TypeError('context must be a plain object');
  }
  requireExactKeys(copiedContext, ['roleIds'], 'context');
  const roles = validateRoleSet(copiedContext.roleIds);
  const roleSet = new Set(roles);
  const seen = new Set();
  const candidates = [];

  for (const raw of copiedDefinitions) {
    const definition = validateRoutineDefinition(raw);
    if (seen.has(definition.routineId)) throw new TypeError('definitions contain duplicate routine IDs');
    seen.add(definition.routineId);
    if (!definition.enabled || !definition.requiredRoleIds.every((roleId) => roleSet.has(roleId))) continue;
    const phase = sequence % definition.period;
    const endOffset = definition.startOffset + definition.duration;
    if (phase < definition.startOffset || phase >= endOffset) continue;
    const windowStart = sequence - phase + definition.startOffset;
    const windowEnd = windowStart + definition.duration;
    if (!Number.isSafeInteger(windowStart) || !Number.isSafeInteger(windowEnd)) {
      throw new TypeError('routine window exceeds safe integer range');
    }
    candidates.push(Object.freeze({
      candidateId: definition.routineId,
      routineId: definition.routineId,
      priority: definition.priority,
      windowStart,
      windowEnd,
      commandTemplate: definition.commandTemplate,
    }));
  }

  candidates.sort((left, right) => (
    left.routineId < right.routineId ? -1 : left.routineId > right.routineId ? 1 : 0
  ));
  return Object.freeze(candidates);
}
