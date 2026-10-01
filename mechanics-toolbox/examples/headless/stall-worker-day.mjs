import { createAgentState } from '../../src/agents/agents.js';
import { createAgentMemory } from '../../src/agents/memory.js';
import { selectAgentDecision } from '../../src/agents/selection.js';
import { buildStallWorkerCandidates } from '../../src/agents/stall-worker.js';
import { rankCandidates } from '../../src/agents/utility.js';

const candidates = buildStallWorkerCandidates({
  agentId: 'agent.stall_worker',
  roleIds: ['role.stall_worker'],
  sequence: 20,
  lowStock: [{
    stallId: 'stall.food', itemId: 'food.stew', current: 1, target: 5,
    recipeId: 'recipe.stew', stationId: 'station.kitchen', priority: 8,
  }],
  openOrders: [{
    orderId: 'order.stew', stallId: 'stall.food', tradeId: 'trade.stew.1',
    quantity: 2, priority: 10,
  }],
});
const rankedCandidates = rankCandidates(candidates, {
  needPressure: 1, routinePriority: 1, skillFit: 1, memoryEvidence: 1,
  taskUrgency: 1, switchingCost: 1, modifiers: 1,
});
const agent = createAgentState({
  agentId: 'agent.stall_worker', actorId: 'actor.worker', needs: [], skills: {},
  roles: ['role.stall_worker'], memory: createAgentMemory(4),
});
const decision = selectAgentDecision({
  decisionId: 'decision.stall.1', agent, sequence: 20, rankedCandidates,
  interruptMargin: 5, hardInterruption: false, reason: 'stall_worker_tick',
});

console.log(JSON.stringify({
  mode: 'indexed-proposals-only',
  selectedCandidateId: decision.winner?.candidateId ?? null,
  proposedCommand: candidates.find((entry) => entry.candidateId === decision.winner?.candidateId)?.commandTemplate ?? null,
}, null, 2));
