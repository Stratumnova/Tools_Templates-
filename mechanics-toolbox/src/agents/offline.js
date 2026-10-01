import { copyImmutableData } from '../core/immutable-data.js';
import { requireStableIdentifier } from '../core/identifiers.js';
import { validateAgentState } from './agents.js';
import { applyAgentDecisionFact, selectAgentDecision } from './selection.js';

function plain(value, name) {
  if (value === null || Array.isArray(value) || typeof value !== 'object'
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function safe(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function compareCandidateFacts(left, right) {
  if (left.sequence !== right.sequence) return left.sequence < right.sequence ? -1 : 1;
  if (left.agentId !== right.agentId) return left.agentId < right.agentId ? -1 : 1;
  return 0;
}

export function advanceAgentsOffline(state, input) {
  const current = copyImmutableData(state, 'state');
  plain(current, 'state');
  plain(current.agentsById, 'state.agentsById');
  plain(current.offlineAgentClaimsById, 'state.offlineAgentClaimsById');
  const request = copyImmutableData(input, 'input');
  plain(request, 'input');
  requireStableIdentifier(request.intervalId, 'input.intervalId');

  if (Object.hasOwn(current.offlineAgentClaimsById, request.intervalId)) {
    const stored = current.offlineAgentClaimsById[request.intervalId];
    return Object.freeze({ state: current, facts: stored.facts, summary: stored.summary });
  }

  safe(request.fromSequence, 'input.fromSequence');
  safe(request.toSequence, 'input.toSequence');
  if (request.toSequence < request.fromSequence) throw new TypeError('offline interval runs backward');
  safe(request.maxDecisions, 'input.maxDecisions');
  if (request.maxDecisions > 10000) throw new TypeError('input.maxDecisions exceeds 10000');
  if (!Array.isArray(request.candidateFacts)) throw new TypeError('input.candidateFacts must be an array');
  if (!Array.isArray(request.decisionIds)) throw new TypeError('input.decisionIds must be an array');

  const agentsById = {};
  for (const [agentId, rawAgent] of Object.entries(current.agentsById)) {
    requireStableIdentifier(agentId, 'state agent ID');
    const agent = validateAgentState(rawAgent);
    if (agent.agentId !== agentId) throw new TypeError('agent map key must match agent ID');
    if (request.fromSequence < agent.lastSequence) throw new TypeError('offline interval is stale');
    agentsById[agentId] = agent;
  }

  const eligible = request.candidateFacts.filter((candidate, index) => {
    plain(candidate, `input.candidateFacts[${index}]`);
    requireStableIdentifier(candidate.agentId, `input.candidateFacts[${index}].agentId`);
    safe(candidate.sequence, `input.candidateFacts[${index}].sequence`);
    if (!Object.hasOwn(agentsById, candidate.agentId)) throw new TypeError('candidate references unknown agent');
    return candidate.sequence > request.fromSequence && candidate.sequence <= request.toSequence;
  }).sort(compareCandidateFacts);
  const selected = eligible.slice(0, request.maxDecisions);
  if (request.decisionIds.length < selected.length) throw new TypeError('not enough injected decision IDs');

  const usedDecisionIds = new Set();
  const facts = [];
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    const decisionId = request.decisionIds[index];
    requireStableIdentifier(decisionId, `input.decisionIds[${index}]`);
    if (usedDecisionIds.has(decisionId)) throw new TypeError('duplicate injected decision ID');
    usedDecisionIds.add(decisionId);
    const agent = agentsById[candidate.agentId];
    const fact = selectAgentDecision({
      decisionId,
      agent,
      sequence: candidate.sequence,
      rankedCandidates: candidate.rankedCandidates,
      interruptMargin: candidate.interruptMargin,
      hardInterruption: candidate.hardInterruption,
      reason: candidate.reason,
    });
    agentsById[candidate.agentId] = applyAgentDecisionFact(agent, fact);
    facts.push(fact);
  }

  const immutableFacts = copyImmutableData(facts, 'facts');
  const summary = copyImmutableData({
    intervalId: request.intervalId,
    fromSequence: request.fromSequence,
    toSequence: request.toSequence,
    considered: eligible.length,
    applied: facts.length,
    truncated: eligible.length - facts.length,
  }, 'summary');
  const claims = {
    ...current.offlineAgentClaimsById,
    [request.intervalId]: Object.freeze({ facts: immutableFacts, summary }),
  };
  const nextState = copyImmutableData({
    ...current,
    agentsById,
    offlineAgentClaimsById: claims,
  }, 'nextState');
  return Object.freeze({ state: nextState, facts: immutableFacts, summary });
}
