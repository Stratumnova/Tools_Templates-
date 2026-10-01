import { copyImmutableData } from '../core/immutable-data.js';
import { requireStableIdentifier } from '../core/identifiers.js';
import { validateRoleSet } from './skills.js';

function plain(value, name) {
  if (value === null || Array.isArray(value) || typeof value !== 'object'
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function exact(value, keys, name) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unsupported or missing fields`);
  }
}

function safe(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function candidate(candidateId, priority, taskUrgency, memoryEvidence, commandTemplate) {
  return Object.freeze({
    candidateId,
    priority,
    needPressure: 0,
    routinePriority: priority,
    skillFit: 0,
    memoryEvidence,
    taskUrgency,
    switchingCost: 0,
    modifiers: 0,
    commandTemplate,
  });
}

export function buildStallWorkerCandidates(context) {
  const input = copyImmutableData(context, 'context');
  plain(input, 'context');
  exact(input, ['agentId', 'roleIds', 'sequence', 'lowStock', 'openOrders'], 'context');
  requireStableIdentifier(input.agentId, 'context.agentId');
  safe(input.sequence, 'context.sequence');
  const roles = validateRoleSet(input.roleIds);
  if (!Array.isArray(input.lowStock)) throw new TypeError('context.lowStock must be an array');
  if (!Array.isArray(input.openOrders)) throw new TypeError('context.openOrders must be an array');
  if (!roles.includes('role.stall_worker')) return Object.freeze([]);

  const candidates = [];
  const ids = new Set();
  input.lowStock.forEach((stock, index) => {
    plain(stock, `context.lowStock[${index}]`);
    exact(stock, ['stallId', 'itemId', 'current', 'target', 'recipeId', 'stationId', 'priority'], `context.lowStock[${index}]`);
    for (const field of ['stallId', 'itemId', 'recipeId', 'stationId']) {
      requireStableIdentifier(stock[field], `context.lowStock[${index}].${field}`);
    }
    safe(stock.current, `context.lowStock[${index}].current`);
    safe(stock.target, `context.lowStock[${index}].target`, 1);
    safe(stock.priority, `context.lowStock[${index}].priority`);
    if (stock.current >= stock.target) return;
    const candidateId = `stall-worker.produce.${stock.itemId}`;
    if (ids.has(candidateId)) throw new TypeError(`duplicate candidate ID ${candidateId}`);
    ids.add(candidateId);
    const shortage = stock.target - stock.current;
    candidates.push(candidate(candidateId, stock.priority, shortage, 1, Object.freeze({
      type: 'production.queue',
      payload: Object.freeze({ recipeId: stock.recipeId, stationId: stock.stationId }),
    })));
  });

  input.openOrders.forEach((order, index) => {
    plain(order, `context.openOrders[${index}]`);
    exact(order, ['orderId', 'stallId', 'tradeId', 'quantity', 'priority'], `context.openOrders[${index}]`);
    for (const field of ['orderId', 'stallId', 'tradeId']) {
      requireStableIdentifier(order[field], `context.openOrders[${index}].${field}`);
    }
    safe(order.quantity, `context.openOrders[${index}].quantity`, 1);
    safe(order.priority, `context.openOrders[${index}].priority`);
    const candidateId = `stall-worker.fulfill.${order.orderId}`;
    if (ids.has(candidateId)) throw new TypeError(`duplicate candidate ID ${candidateId}`);
    ids.add(candidateId);
    candidates.push(candidate(candidateId, order.priority, order.quantity, 2, Object.freeze({
      type: 'market.buy_order_fulfill',
      payload: Object.freeze({
        orderId: order.orderId,
        stallId: order.stallId,
        tradeId: order.tradeId,
        quantity: order.quantity,
      }),
    })));
  });

  candidates.sort((left, right) => (
    left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0
  ));
  return Object.freeze(candidates);
}
