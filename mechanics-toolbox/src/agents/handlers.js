import { accept, reject } from '../core/contracts.js';
import { copyImmutableData } from '../core/immutable-data.js';
import { createAgentState, validateAgentState } from './agents.js';
import { advanceNeed } from './needs.js';
import { rememberObservation } from './memory.js';
import { applyAgentDecisionFact, selectAgentDecision } from './selection.js';

class AgentHandlerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function plain(value, name) {
  if (value === null || Array.isArray(value) || typeof value !== 'object'
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function commandPayload(command) {
  const payload = copyImmutableData(command.payload, 'command.payload');
  plain(payload, 'command.payload');
  const result = { ...payload };
  delete result.actorId;
  return result;
}

function agentsMap(state) {
  plain(state, 'state');
  const map = state.agentsById;
  plain(map, 'state.agentsById');
  return map;
}

function ownedAgent(state, agentId, actorId) {
  const map = agentsMap(state);
  if (!Object.hasOwn(map, agentId)) throw new AgentHandlerError('agent.not_found', 'Agent does not exist', { agentId });
  const agent = validateAgentState(map[agentId]);
  if (agent.actorId !== actorId) {
    throw new AgentHandlerError('agent.forbidden', 'Actor does not own this agent', { agentId, actorId });
  }
  return agent;
}

function replaceAgent(state, agent) {
  const map = agentsMap(state);
  return { ...state, agentsById: { ...map, [agent.agentId]: validateAgentState(agent) } };
}

function decideSafely(planner, eventType) {
  return {
    decide(state, command, context) {
      try {
        const fact = planner(state, commandPayload(command), command.actorId);
        return accept([context.createEvent(eventType, fact)]);
      } catch (error) {
        if (error instanceof AgentHandlerError) return reject(error.code, error.message, error.details);
        if (error instanceof TypeError || error instanceof RangeError) {
          return reject('agent.invalid', error.message, {});
        }
        throw error;
      }
    },
    reduce: null,
  };
}

function registrationHandler() {
  const handler = decideSafely((state, payload, actorId) => {
    const map = agentsMap(state);
    if (Object.hasOwn(map, payload.agentId)) {
      throw new AgentHandlerError('agent.duplicate', 'Agent already exists', { agentId: payload.agentId });
    }
    return { agent: createAgentState({ ...payload, actorId }) };
  }, 'agent.registered');
  handler.reduce = (state, event) => {
    const payload = copyImmutableData(event.payload, 'event.payload');
    plain(payload, 'event.payload');
    const agent = validateAgentState(payload.agent);
    const map = agentsMap(state);
    if (Object.hasOwn(map, agent.agentId)) throw new TypeError('agent already exists during replay');
    return replaceAgent(state, agent);
  };
  return handler;
}

function needHandler() {
  const handler = decideSafely((state, payload, actorId) => {
    const agent = ownedAgent(state, payload.agentId, actorId);
    const index = agent.needs.findIndex((need) => need.needId === payload.definition?.needId);
    if (index < 0) throw new AgentHandlerError('agent.need_not_found', 'Agent need does not exist', { agentId: agent.agentId });
    return {
      agentId: agent.agentId,
      need: advanceNeed(agent.needs[index], payload.definition, payload.targetSequence),
    };
  }, 'agent.need_advanced');
  handler.reduce = (state, event) => {
    const { agentId, need } = copyImmutableData(event.payload, 'event.payload');
    const map = agentsMap(state);
    if (!Object.hasOwn(map, agentId)) throw new TypeError('agent does not exist during replay');
    const agent = validateAgentState(map[agentId]);
    const index = agent.needs.findIndex((entry) => entry.needId === need.needId);
    if (index < 0) throw new TypeError('need does not exist during replay');
    const needs = [...agent.needs];
    needs[index] = need;
    return replaceAgent(state, { ...agent, needs });
  };
  return handler;
}

function memoryHandler() {
  const handler = decideSafely((state, payload, actorId) => {
    const agent = ownedAgent(state, payload.agentId, actorId);
    return { agentId: agent.agentId, memory: rememberObservation(agent.memory, payload.observation) };
  }, 'agent.memory_observed');
  handler.reduce = (state, event) => {
    const { agentId, memory } = copyImmutableData(event.payload, 'event.payload');
    const map = agentsMap(state);
    if (!Object.hasOwn(map, agentId)) throw new TypeError('agent does not exist during replay');
    return replaceAgent(state, { ...map[agentId], memory });
  };
  return handler;
}

function decisionHandler(commandType, eventType, transform = (payload) => payload) {
  const handler = decideSafely((state, payload, actorId) => {
    const agent = ownedAgent(state, payload.agentId, actorId);
    const input = transform(payload, agent);
    return { agentId: agent.agentId, fact: selectAgentDecision({ ...input, agent }) };
  }, eventType);
  handler.reduce = (state, event) => {
    const { agentId, fact } = copyImmutableData(event.payload, 'event.payload');
    const map = agentsMap(state);
    if (!Object.hasOwn(map, agentId)) throw new TypeError('agent does not exist during replay');
    return replaceAgent(state, applyAgentDecisionFact(map[agentId], fact));
  };
  return handler;
}

function terminalHandler(action, eventType) {
  const handler = decideSafely((state, payload, actorId) => {
    const agent = ownedAgent(state, payload.agentId, actorId);
    const fact = {
      decisionId: payload.decisionId,
      agentId: agent.agentId,
      sequence: payload.sequence,
      action,
      winner: null,
      rankedCandidates: [],
      previousGoal: agent.currentGoal,
      reason: payload.reason,
    };
    applyAgentDecisionFact(agent, fact);
    return { agentId: agent.agentId, fact };
  }, eventType);
  handler.reduce = (state, event) => {
    const { agentId, fact } = copyImmutableData(event.payload, 'event.payload');
    const map = agentsMap(state);
    return replaceAgent(state, applyAgentDecisionFact(map[agentId], fact));
  };
  return handler;
}

export function createAgentHandlers(options = {}) {
  plain(options, 'options');
  const register = registrationHandler();
  const need = needHandler();
  const memory = memoryHandler();
  const decide = decisionHandler('agent.decide', 'agent.decision_applied');
  const interrupt = decisionHandler('agent.goal_interrupt', 'agent.goal_interrupted', (payload) => ({
    ...payload,
    hardInterruption: true,
  }));
  const resume = decisionHandler('agent.goal_resume', 'agent.goal_resumed');
  const complete = terminalHandler('complete', 'agent.goal_completed');
  return Object.freeze({
    'agent.register': register,
    'agent.need_advance': need,
    'agent.memory_observe': memory,
    'agent.decide': decide,
    'agent.goal_interrupt': interrupt,
    'agent.goal_resume': resume,
    'agent.goal_complete': complete,
  });
}
