import { copyImmutableData } from '../core/immutable-data.js';
import { requireStableIdentifier } from '../core/identifiers.js';
import { validateSkillProfile, validateRoleSet } from './skills.js';
import { createAgentMemory, rememberObservation } from './memory.js';

const STATE_KEYS = Object.freeze([
  'agentId', 'actorId', 'needs', 'skills', 'roles', 'memory', 'currentGoal',
  'suspendedGoals', 'completedGoalIds', 'decisionIds', 'lastSequence',
]);
const GOAL_KEYS = Object.freeze(['candidateId', 'total', 'status', 'startedSequence', 'lastSequence']);

function exact(value, keys, name) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unsupported or missing fields`);
  }
}

function safe(value, name, minimum) {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) {
    throw new TypeError(`${name} must be a safe integer${minimum === undefined ? '' : ` of at least ${minimum}`}`);
  }
  return value;
}

function validateNeedStates(needs) {
  if (!Array.isArray(needs)) throw new TypeError('needs must be an array');
  const seen = new Set();
  for (let index = 0; index < needs.length; index += 1) {
    const need = needs[index];
    if (need === null || Array.isArray(need) || Object.getPrototypeOf(need) !== Object.prototype) {
      throw new TypeError(`needs[${index}] must be a plain object`);
    }
    exact(need, ['needId', 'value', 'lastSequence', 'appliedIntervals'], `needs[${index}]`);
    requireStableIdentifier(need.needId, `needs[${index}].needId`);
    safe(need.value, `needs[${index}].value`);
    safe(need.lastSequence, `needs[${index}].lastSequence`, 0);
    safe(need.appliedIntervals, `needs[${index}].appliedIntervals`, 0);
    if (seen.has(need.needId)) throw new TypeError('needs contain duplicate IDs');
    seen.add(need.needId);
  }
  return needs;
}

function validateMemory(memory) {
  if (memory === null || Array.isArray(memory) || Object.getPrototypeOf(memory) !== Object.prototype) {
    throw new TypeError('memory must be a plain object');
  }
  exact(memory, ['capacity', 'observations'], 'memory');
  let rebuilt = createAgentMemory(memory.capacity);
  if (!Array.isArray(memory.observations)) throw new TypeError('memory.observations must be an array');
  for (const observation of memory.observations) rebuilt = rememberObservation(rebuilt, observation);
  if (rebuilt.observations.length !== memory.observations.length) {
    throw new TypeError('memory observations exceed capacity');
  }
  return rebuilt;
}

export function validateGoal(goal, name = 'goal') {
  if (goal === null || Array.isArray(goal) || Object.getPrototypeOf(goal) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  exact(goal, GOAL_KEYS, name);
  requireStableIdentifier(goal.candidateId, `${name}.candidateId`);
  safe(goal.total, `${name}.total`);
  if (!['active', 'suspended'].includes(goal.status)) throw new TypeError(`${name}.status is invalid`);
  safe(goal.startedSequence, `${name}.startedSequence`, 0);
  safe(goal.lastSequence, `${name}.lastSequence`, goal.startedSequence);
  return goal;
}

export function validateAgentState(state) {
  const copy = copyImmutableData(state, 'state');
  if (copy === null || Array.isArray(copy) || Object.getPrototypeOf(copy) !== Object.prototype) {
    throw new TypeError('state must be a plain object');
  }
  exact(copy, STATE_KEYS, 'state');
  requireStableIdentifier(copy.agentId, 'state.agentId');
  requireStableIdentifier(copy.actorId, 'state.actorId');
  validateNeedStates(copy.needs);
  validateSkillProfile(copy.skills);
  validateRoleSet(copy.roles);
  const memory = validateMemory(copy.memory);
  if (copy.currentGoal !== null) validateGoal(copy.currentGoal, 'state.currentGoal');
  if (!Array.isArray(copy.suspendedGoals)) throw new TypeError('state.suspendedGoals must be an array');
  const goalIds = new Set();
  if (copy.currentGoal) goalIds.add(copy.currentGoal.candidateId);
  for (const goal of copy.suspendedGoals) {
    validateGoal(goal, 'state.suspendedGoals entry');
    if (goal.status !== 'suspended' || goalIds.has(goal.candidateId)) throw new TypeError('invalid suspended goal');
    goalIds.add(goal.candidateId);
  }
  if (!Array.isArray(copy.completedGoalIds)) throw new TypeError('state.completedGoalIds must be an array');
  const completed = new Set();
  for (const id of copy.completedGoalIds) {
    requireStableIdentifier(id, 'state completed goal ID');
    if (completed.has(id) || goalIds.has(id)) throw new TypeError('duplicate or live completed goal ID');
    completed.add(id);
  }
  if (!Array.isArray(copy.decisionIds)) throw new TypeError('state.decisionIds must be an array');
  const decisions = new Set();
  for (const id of copy.decisionIds) {
    requireStableIdentifier(id, 'state decision ID');
    if (decisions.has(id)) throw new TypeError('duplicate decision ID');
    decisions.add(id);
  }
  safe(copy.lastSequence, 'state.lastSequence', 0);
  return Object.freeze({ ...copy, memory });
}

export function createAgentState(input) {
  const copy = copyImmutableData(input, 'input');
  if (copy === null || Array.isArray(copy) || Object.getPrototypeOf(copy) !== Object.prototype) {
    throw new TypeError('input must be a plain object');
  }
  exact(copy, ['agentId', 'actorId', 'needs', 'skills', 'roles', 'memory'], 'input');
  return validateAgentState({
    ...copy,
    currentGoal: null,
    suspendedGoals: [],
    completedGoalIds: [],
    decisionIds: [],
    lastSequence: 0,
  });
}
