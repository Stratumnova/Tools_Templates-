import { copyImmutableData } from '../core/immutable-data.js';
import { requireStableIdentifier } from '../core/identifiers.js';
import { validateAgentState, validateGoal } from './agents.js';

const COMPONENTS = Object.freeze([
  'needPressure', 'routinePriority', 'skillFit', 'memoryEvidence',
  'taskUrgency', 'switchingCost', 'modifiers',
]);
const ACTIONS = Object.freeze(['idle', 'start', 'retain', 'interrupt', 'suspend', 'resume', 'complete']);

function safe(value, name, minimum) {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
}

function validateRanking(ranking, name) {
  if (ranking === null || Array.isArray(ranking) || Object.getPrototypeOf(ranking) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const keys = Object.keys(ranking).sort();
  const expected = ['candidateId', 'components', 'priority', 'total'].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unsupported or missing fields`);
  }
  requireStableIdentifier(ranking.candidateId, `${name}.candidateId`);
  safe(ranking.priority, `${name}.priority`, 0);
  safe(ranking.total, `${name}.total`);
  if (ranking.components === null || Array.isArray(ranking.components)
      || Object.getPrototypeOf(ranking.components) !== Object.prototype) {
    throw new TypeError(`${name}.components must be a plain object`);
  }
  const componentKeys = Object.keys(ranking.components).sort();
  const expectedComponents = [...COMPONENTS].sort();
  if (componentKeys.length !== expectedComponents.length
      || componentKeys.some((key, index) => key !== expectedComponents[index])) {
    throw new TypeError(`${name}.components are incomplete`);
  }
  for (const component of COMPONENTS) safe(ranking.components[component], `${name}.components.${component}`);
  return ranking;
}

function validateRankings(rankings) {
  if (!Array.isArray(rankings)) throw new TypeError('rankedCandidates must be an array');
  const seen = new Set();
  rankings.forEach((ranking, index) => {
    validateRanking(ranking, `rankedCandidates[${index}]`);
    if (seen.has(ranking.candidateId)) throw new TypeError('rankedCandidates contain duplicate IDs');
    seen.add(ranking.candidateId);
  });
  return rankings;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function selectAgentDecision(input) {
  const copy = copyImmutableData(input, 'input');
  const agent = validateAgentState(copy.agent);
  requireStableIdentifier(copy.decisionId, 'input.decisionId');
  safe(copy.sequence, 'input.sequence', 0);
  if (copy.sequence < agent.lastSequence) throw new TypeError('input.sequence is stale');
  const rankings = validateRankings(copy.rankedCandidates);
  safe(copy.interruptMargin, 'input.interruptMargin', 0);
  if (typeof copy.hardInterruption !== 'boolean') throw new TypeError('input.hardInterruption must be boolean');
  requireStableIdentifier(copy.reason, 'input.reason');

  const winner = rankings[0] ?? null;
  let action;
  if (agent.currentGoal === null) {
    if (winner === null) action = 'idle';
    else if (agent.suspendedGoals.some((goal) => goal.candidateId === winner.candidateId)) action = 'resume';
    else action = 'start';
  } else if (winner === null || winner.candidateId === agent.currentGoal.candidateId) {
    action = 'retain';
  } else if (copy.hardInterruption
      || BigInt(winner.total) >= BigInt(agent.currentGoal.total) + BigInt(copy.interruptMargin)) {
    action = 'interrupt';
  } else action = 'retain';

  return Object.freeze({
    decisionId: copy.decisionId,
    agentId: agent.agentId,
    sequence: copy.sequence,
    action,
    winner,
    rankedCandidates: rankings,
    previousGoal: agent.currentGoal,
    reason: copy.reason,
  });
}

export function applyAgentDecisionFact(state, fact) {
  const agent = validateAgentState(state);
  const resolved = copyImmutableData(fact, 'fact');
  const keys = Object.keys(resolved).sort();
  const expected = ['decisionId', 'agentId', 'sequence', 'action', 'winner', 'rankedCandidates', 'previousGoal', 'reason'].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('fact has unsupported or missing fields');
  }
  requireStableIdentifier(resolved.decisionId, 'fact.decisionId');
  requireStableIdentifier(resolved.agentId, 'fact.agentId');
  requireStableIdentifier(resolved.reason, 'fact.reason');
  if (resolved.agentId !== agent.agentId) throw new TypeError('fact agent does not match state');
  if (agent.decisionIds.includes(resolved.decisionId)) throw new TypeError('duplicate decision ID');
  safe(resolved.sequence, 'fact.sequence', 0);
  if (resolved.sequence < agent.lastSequence) throw new TypeError('fact sequence is stale');
  if (!ACTIONS.includes(resolved.action)) throw new TypeError('fact action is invalid');
  validateRankings(resolved.rankedCandidates);
  if (resolved.winner !== null) validateRanking(resolved.winner, 'fact.winner');
  if (resolved.previousGoal !== null) validateGoal(resolved.previousGoal, 'fact.previousGoal');
  if (!same(resolved.previousGoal, agent.currentGoal)) throw new TypeError('fact previous goal is stale');

  let currentGoal = agent.currentGoal;
  let suspendedGoals = [...agent.suspendedGoals];
  let completedGoalIds = [...agent.completedGoalIds];
  const makeGoal = (winner, startedSequence = resolved.sequence) => Object.freeze({
    candidateId: winner.candidateId,
    total: winner.total,
    status: 'active',
    startedSequence,
    lastSequence: resolved.sequence,
  });

  if (resolved.action === 'idle') {
    if (currentGoal !== null || resolved.winner !== null) throw new TypeError('idle fact is incoherent');
  } else if (resolved.action === 'start') {
    if (currentGoal !== null || resolved.winner === null) throw new TypeError('start fact is incoherent');
    if (completedGoalIds.includes(resolved.winner.candidateId)) throw new TypeError('completed goal is terminal');
    currentGoal = makeGoal(resolved.winner);
  } else if (resolved.action === 'retain') {
    if (currentGoal === null) throw new TypeError('retain requires an active goal');
    currentGoal = Object.freeze({ ...currentGoal, lastSequence: resolved.sequence });
  } else if (resolved.action === 'interrupt') {
    if (currentGoal === null || resolved.winner === null) throw new TypeError('interrupt fact is incoherent');
    suspendedGoals.push(Object.freeze({ ...currentGoal, status: 'suspended', lastSequence: resolved.sequence }));
    currentGoal = makeGoal(resolved.winner);
  } else if (resolved.action === 'suspend') {
    if (currentGoal === null || resolved.winner !== null) throw new TypeError('suspend fact is incoherent');
    suspendedGoals.push(Object.freeze({ ...currentGoal, status: 'suspended', lastSequence: resolved.sequence }));
    currentGoal = null;
  } else if (resolved.action === 'resume') {
    if (currentGoal !== null || resolved.winner === null) throw new TypeError('resume fact is incoherent');
    const index = suspendedGoals.findIndex((goal) => goal.candidateId === resolved.winner.candidateId);
    if (index < 0 || completedGoalIds.includes(resolved.winner.candidateId)) throw new TypeError('goal cannot resume');
    const [goal] = suspendedGoals.splice(index, 1);
    currentGoal = makeGoal(resolved.winner, goal.startedSequence);
  } else if (resolved.action === 'complete') {
    if (currentGoal === null || resolved.winner !== null) throw new TypeError('complete fact is incoherent');
    if (completedGoalIds.includes(currentGoal.candidateId)) throw new TypeError('goal already completed');
    completedGoalIds.push(currentGoal.candidateId);
    currentGoal = null;
  }

  return validateAgentState({
    ...agent,
    currentGoal,
    suspendedGoals,
    completedGoalIds,
    decisionIds: [...agent.decisionIds, resolved.decisionId],
    lastSequence: resolved.sequence,
  });
}
