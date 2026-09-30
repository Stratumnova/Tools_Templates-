import { copyImmutableData } from '../core/immutable-data.js';

export class MarketError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    this.details = copyImmutableData(details, 'details');
  }
}

const ROLE_CATEGORIES = Object.freeze({
  farmer: Object.freeze(['food', 'produce', 'seed', 'tool']),
  beast_master: Object.freeze(['animal', 'feed', 'medicine', 'tack']),
});
const TERMINAL = new Set(['filled', 'cancelled', 'expired']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(code, message, details = {}) { throw new MarketError(code, message, details); }
function plain(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('market.invalid_input', name + ' must be a plain own-property record');
  }
  return value;
}
function stableId(value, name) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)
      || FORBIDDEN_KEYS.has(value)) fail('market.invalid_input', name + ' must be a safe stable identifier');
  return value;
}
function safeInt(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail('market.invalid_input', name + ' must be a safe integer >= ' + minimum);
  }
  return value;
}
function safeAdd(left, right, name) {
  safeInt(left, name); safeInt(right, name);
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail('market.arithmetic_overflow', name + ' exceeds safe integer range');
  return result;
}
function safeMultiply(left, right, name) {
  safeInt(left, name); safeInt(right, name);
  const result = left * right;
  if (!Number.isSafeInteger(result)) fail('market.arithmetic_overflow', name + ' exceeds safe integer range');
  return result;
}
function own(map, key) { return Object.hasOwn(map, key); }
function getQuantity(map, key) { return own(map, key) ? map[key] : 0; }

function cloneData(value, name = 'market data', ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('market.invalid_input', name + ' contains a non-finite number');
    return value;
  }
  if (typeof value !== 'object') fail('market.invalid_input', name + ' must contain JSON-compatible data');
  if (ancestors.has(value)) fail('market.invalid_input', name + ' must not contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          fail('market.invalid_input', name + ' must not contain sparse or accessor array entries');
        }
        result.push(cloneData(descriptor.value, name + '[' + index + ']', ancestors));
      }
      const allowed = new Set([...Array(value.length).keys()].map(String).concat('length'));
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !allowed.has(key)) fail('market.invalid_input', name + ' contains unsupported array properties');
      }
      return result;
    }
    plain(value, name);
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) fail('market.invalid_input', name + ' contains an unsafe key');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('market.invalid_input', name + ' must contain enumerable data properties only');
      }
      Object.defineProperty(result, key, {
        value: cloneData(descriptor.value, name + '.' + key, ancestors),
        enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function denseStrings(value, name) {
  const copy = cloneData(value, name);
  if (!Array.isArray(copy)) fail('market.invalid_input', name + ' must be a dense array');
  for (const entry of copy) if (typeof entry !== 'string' || entry.trim() === '') {
    fail('market.invalid_input', name + ' must contain nonblank strings');
  }
  return [...new Set(copy)];
}
function record(value, name) {
  plain(value, name);
  for (const key of Object.keys(value)) stableId(key, name + ' key');
  return value;
}
function sortedRecord(input) {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}
function addQuantity(map, key, amount) {
  stableId(key, 'itemId'); safeInt(amount, 'quantity delta');
  const result = safeAdd(getQuantity(map, key), amount, 'resulting quantity');
  if (result === 0) delete map[key]; else map[key] = result;
}
function subtractQuantity(map, key, amount) {
  stableId(key, 'itemId'); safeInt(amount, 'quantity delta');
  const current = getQuantity(map, key);
  if (current < amount) fail('market.insufficient_stock', 'quantity would become negative', { itemId: key, available: current });
  const result = current - amount;
  if (result === 0) delete map[key]; else map[key] = result;
}
function actor(state, actorId) {
  const result = own(state.actorsById, actorId) ? state.actorsById[actorId] : null;
  if (!result) fail('market.actor_not_found', 'actor does not exist', { actorId });
  return result;
}
function stall(state, stallId) {
  const result = own(state.stallsById, stallId) ? state.stallsById[stallId] : null;
  if (!result) fail('market.stall_not_found', 'stall does not exist', { stallId });
  return result;
}
function order(state, orderId) {
  const result = own(state.ordersById, orderId) ? state.ordersById[orderId] : null;
  if (!result) fail('market.order_not_found', 'order does not exist', { orderId });
  return result;
}
function requireOwner(actualActorId, ownerId, subject) {
  if (actualActorId !== ownerId) fail('market.owner_mismatch', 'actor does not own ' + subject, { actorId: actualActorId, ownerId });
}
function roleSupports(stallValue, category) {
  return stallValue.roles.some(role => ROLE_CATEGORIES[role].includes(category));
}

export function createMarketState(input = {}) {
  plain(input, 'input');
  const copy = cloneData(input, 'market state');
  const state = {
    actorsById: copy.actorsById ?? {},
    stallsById: copy.stallsById ?? {},
    ordersById: copy.ordersById ?? {},
    trades: copy.trades ?? [],
  };
  validateMarketState(state);
  return state;
}

export function validateMarketState(input) {
  plain(input, 'state');
  record(input.actorsById, 'actorsById');
  record(input.stallsById, 'stallsById');
  record(input.ordersById, 'ordersById');
  if (!Array.isArray(input.trades)) fail('market.invalid_state', 'trades must be a dense array');
  cloneData(input.trades, 'trades');

  for (const [actorId, value] of Object.entries(input.actorsById)) {
    stableId(actorId, 'actorId'); plain(value, 'actor'); safeInt(value.balance, 'balance');
    record(value.items, 'actor items');
    for (const amount of Object.values(value.items)) safeInt(amount, 'item quantity', 1);
  }

  for (const [stallId, value] of Object.entries(input.stallsById)) {
    stableId(stallId, 'stallId'); plain(value, 'stall');
    stableId(value.ownerId, 'ownerId'); actor(input, value.ownerId);
    const roles = denseStrings(value.roles, 'roles');
    for (const role of roles) if (!own(ROLE_CATEGORIES, role)) fail('market.unknown_role', 'role is not routable', { role });
    denseStrings(value.categories, 'categories');
    safeInt(value.basePriceBps, 'basePriceBps', 1);
    safeInt(value.stockPressureBps, 'stockPressureBps', 1);
    record(value.stock, 'stock'); record(value.prices ?? {}, 'prices');
    for (const amount of Object.values(value.stock)) safeInt(amount, 'stock quantity', 1);
    for (const price of Object.values(value.prices ?? {})) safeInt(price, 'item price', 1);
  }

  for (const [orderId, value] of Object.entries(input.ordersById)) {
    stableId(orderId, 'orderId'); plain(value, 'order');
    stableId(value.buyerId, 'buyerId'); actor(input, value.buyerId);
    stableId(value.itemId, 'itemId'); stableId(value.category, 'category');
    safeInt(value.quantity, 'quantity', 1); safeInt(value.remaining, 'remaining');
    safeInt(value.limitUnitPrice, 'limitUnitPrice', 1); safeInt(value.escrow, 'escrow');
    safeInt(value.createdSequence, 'createdSequence');
    safeInt(value.expiresSequence, 'expiresSequence', value.createdSequence + 1);
    if (!['open', 'filled', 'cancelled', 'expired'].includes(value.status)) {
      fail('market.invalid_state', 'invalid order status', { orderId });
    }
    if (value.remaining > value.quantity) fail('market.invalid_state', 'remaining quantity exceeds order quantity', { orderId });
    const exactEscrow = safeMultiply(value.remaining, value.limitUnitPrice, 'order escrow');
    if (value.status === 'open' && value.escrow !== exactEscrow) {
      fail('market.invalid_state', 'open order escrow must exactly fund its remainder', { orderId });
    }
    if (value.status === 'filled' && (value.remaining !== 0 || value.escrow !== 0)) {
      fail('market.invalid_state', 'filled order must have zero remainder and escrow', { orderId });
    }
    if ((value.status === 'cancelled' || value.status === 'expired') && value.escrow !== 0) {
      fail('market.invalid_state', 'closed order must have zero escrow', { orderId });
    }
  }

  const tradeIds = new Set();
  const tradedByOrder = new Map();
  for (const value of input.trades) {
    plain(value, 'trade');
    for (const field of ['tradeId', 'orderId', 'stallId', 'buyerId', 'sellerId', 'itemId']) stableId(value[field], field);
    if (tradeIds.has(value.tradeId)) fail('market.duplicate_trade', 'trade ID is duplicated', { tradeId: value.tradeId });
    tradeIds.add(value.tradeId);
    const linkedOrder = order(input, value.orderId); const linkedStall = stall(input, value.stallId);
    actor(input, value.buyerId); actor(input, value.sellerId);
    if (value.buyerId !== linkedOrder.buyerId || value.itemId !== linkedOrder.itemId
        || value.sellerId !== linkedStall.ownerId) fail('market.invalid_state', 'trade references are inconsistent', { tradeId: value.tradeId });
    safeInt(value.quantity, 'trade quantity', 1); safeInt(value.unitPrice, 'unitPrice', 1);
    safeInt(value.total, 'trade total', 1); safeInt(value.sequence, 'trade sequence');
    if (value.total !== safeMultiply(value.quantity, value.unitPrice, 'trade total')) {
      fail('market.invalid_state', 'trade total is inconsistent', { tradeId: value.tradeId });
    }
    tradedByOrder.set(value.orderId, safeAdd(tradedByOrder.get(value.orderId) ?? 0, value.quantity, 'traded quantity'));
  }
  for (const [orderId, value] of Object.entries(input.ordersById)) {
    const traded = tradedByOrder.get(orderId) ?? 0;
    if (traded > value.quantity || value.remaining !== value.quantity - traded) {
      fail('market.invalid_state', 'order remainder does not match recorded trades', { orderId, traded });
    }
  }
  return input;
}

export function createActor(state, input) {
  const next = createMarketState(state); const args = cloneData(input, 'input');
  plain(args, 'input'); const actorId = stableId(args.actorId, 'actorId');
  if (own(next.actorsById, actorId)) fail('market.duplicate_actor', 'actor already exists', { actorId });
  safeInt(args.balance, 'balance'); const items = args.items ?? {}; record(items, 'items');
  for (const amount of Object.values(items)) safeInt(amount, 'item quantity', 1);
  next.actorsById[actorId] = { balance: args.balance, items: sortedRecord(items) };
  next.actorsById = sortedRecord(next.actorsById);
  return next;
}

export function openStall(state, input) {
  const next = createMarketState(state); const args = cloneData(input, 'input'); plain(args, 'input');
  const stallId = stableId(args.stallId, 'stallId'); const ownerId = stableId(args.ownerId, 'ownerId');
  actor(next, ownerId); requireOwner(args.actorId ?? ownerId, ownerId, 'stall');
  if (own(next.stallsById, stallId)) fail('market.duplicate_stall', 'stall already exists', { stallId });
  const roles = denseStrings(args.roles ?? [], 'roles').sort();
  for (const role of roles) if (!own(ROLE_CATEGORIES, role)) fail('market.unknown_role', 'role is not routable', { role });
  const categories = denseStrings(args.categories ?? [], 'categories').sort();
  const stock = args.stock ?? {}; const prices = args.prices ?? {};
  record(stock, 'stock'); record(prices, 'prices');
  for (const [itemId, amount] of Object.entries(stock)) {
    safeInt(amount, 'stock quantity', 1);
    if (getQuantity(actor(next, ownerId).items, itemId) < amount) {
      fail('market.insufficient_stock', 'owner lacks opening stock', { itemId });
    }
    if (own(prices, itemId)) safeInt(prices[itemId], 'item price', 1);
  }
  for (const price of Object.values(prices)) safeInt(price, 'item price', 1);
  for (const [itemId, amount] of Object.entries(stock)) subtractQuantity(actor(next, ownerId).items, itemId, amount);
  next.stallsById[stallId] = {
    ownerId, roles, categories, stock: sortedRecord(stock), prices: sortedRecord(prices),
    basePriceBps: safeInt(args.basePriceBps ?? 10000, 'basePriceBps', 1),
    stockPressureBps: safeInt(args.stockPressureBps ?? 10000, 'stockPressureBps', 1),
  };
  next.stallsById = sortedRecord(next.stallsById);
  return next;
}

export function quoteUnitPrice(input) {
  const args = cloneData(input, 'input'); plain(args, 'input');
  const base = safeInt(args.baseUnitPrice, 'baseUnitPrice', 1);
  const modifiers = args.modifiersBps ?? [];
  if (!Array.isArray(modifiers)) fail('market.invalid_input', 'modifiersBps must be an array');
  let numerator = BigInt(base); let denominator = 1n;
  for (const modifier of modifiers) {
    safeInt(modifier, 'modifierBps', 1);
    numerator *= BigInt(modifier); denominator *= 10000n;
  }
  const rounded = (numerator + denominator / 2n) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) fail('market.price_overflow', 'quoted price exceeds safe integer range');
  return Math.max(1, Number(rounded));
}

export function placeBuyOrder(state, input) {
  const next = createMarketState(state); const args = cloneData(input, 'input'); plain(args, 'input');
  const orderId = stableId(args.orderId, 'orderId'); const buyerId = stableId(args.buyerId, 'buyerId');
  stableId(args.itemId, 'itemId'); stableId(args.category, 'category'); actor(next, buyerId);
  requireOwner(args.actorId ?? buyerId, buyerId, 'buy order');
  if (own(next.ordersById, orderId)) fail('market.duplicate_order', 'order already exists', { orderId });
  const quantity = safeInt(args.quantity, 'quantity', 1);
  const limitUnitPrice = safeInt(args.limitUnitPrice, 'limitUnitPrice', 1);
  const createdSequence = safeInt(args.createdSequence, 'createdSequence');
  const expiresSequence = args.expiresSequence === undefined
    ? Number.MAX_SAFE_INTEGER : safeInt(args.expiresSequence, 'expiresSequence', createdSequence + 1);
  const escrow = safeMultiply(quantity, limitUnitPrice, 'escrow');
  const buyer = actor(next, buyerId);
  if (buyer.balance < escrow) fail('market.insufficient_funds', 'buyer cannot fund order', { buyerId, escrow });
  buyer.balance -= escrow;
  next.ordersById[orderId] = {
    buyerId, itemId: args.itemId, category: args.category, quantity, remaining: quantity,
    limitUnitPrice, escrow, status: 'open', createdSequence, expiresSequence,
  };
  next.ordersById = sortedRecord(next.ordersById);
  return next;
}

function priceFor(stallValue, target) {
  const base = own(stallValue.prices, target.itemId) ? stallValue.prices[target.itemId] : target.limitUnitPrice;
  return quoteUnitPrice({ baseUnitPrice: base, modifiersBps: [stallValue.basePriceBps, stallValue.stockPressureBps] });
}

export function routeStalls(state, orderId) {
  const valid = createMarketState(state); const target = order(valid, stableId(orderId, 'orderId'));
  if (target.status !== 'open') fail('market.order_closed', 'order is not open', { orderId });
  return Object.entries(valid.stallsById)
    .filter(([, value]) => getQuantity(value.stock, target.itemId) > 0
      && (value.categories.includes(target.category) || roleSupports(value, target.category)))
    .map(([stallId, value]) => ({
      stallId, unitPrice: priceFor(value, target), roleMatch: roleSupports(value, target.category),
    }))
    .filter(route => route.unitPrice <= target.limitUnitPrice)
    .sort((left, right) => Number(right.roleMatch) - Number(left.roleMatch)
      || left.unitPrice - right.unitPrice || left.stallId.localeCompare(right.stallId));
}

function planFulfillment(state, input) {
  const valid = createMarketState(state); const args = cloneData(input, 'input'); plain(args, 'input');
  const target = order(valid, stableId(args.orderId, 'orderId'));
  if (target.status !== 'open') fail('market.order_closed', 'order is not open', { orderId: args.orderId });
  const selected = stall(valid, stableId(args.stallId, 'stallId'));
  requireOwner(args.actorId ?? selected.ownerId, selected.ownerId, 'stall');
  if (selected.ownerId === target.buyerId) fail('market.self_trade', 'buyer cannot fulfill their own order');
  const sequence = safeInt(args.currentSequence ?? target.createdSequence, 'currentSequence');
  if (sequence >= target.expiresSequence) fail('market.order_expired', 'order has reached its expiration boundary', { orderId: args.orderId });
  if (!selected.categories.includes(target.category) && !roleSupports(selected, target.category)) {
    fail('market.route_rejected', 'stall does not serve order category', { stallId: args.stallId, category: target.category });
  }
  const tradeId = stableId(args.tradeId, 'tradeId');
  if (valid.trades.some(trade => trade.tradeId === tradeId)) fail('market.duplicate_trade', 'trade already exists', { tradeId });
  const baseUnitPrice = own(selected.prices, target.itemId) ? selected.prices[target.itemId] : target.limitUnitPrice;
  const pricingBaseBps = selected.basePriceBps;
  const pricingStockBps = selected.stockPressureBps;
  const unitPrice = quoteUnitPrice({ baseUnitPrice, modifiersBps: [pricingBaseBps, pricingStockBps] });
  if (unitPrice > target.limitUnitPrice) fail('market.price_exceeds_limit', 'quoted price exceeds order limit', { unitPrice });
  const requested = safeInt(args.quantity, 'quantity', 1);
  const filledQuantity = Math.min(requested, target.remaining, getQuantity(selected.stock, target.itemId));
  if (filledQuantity === 0) fail('market.no_fill', 'no quantity can be fulfilled');
  const total = safeMultiply(filledQuantity, unitPrice, 'trade total');
  const escrowReleased = safeMultiply(filledQuantity, target.limitUnitPrice, 'released escrow');
  return {
    tradeId, orderId: args.orderId, stallId: args.stallId, buyerId: target.buyerId,
    sellerId: selected.ownerId, itemId: target.itemId, filledQuantity,
    baseUnitPrice, pricingBaseBps, pricingStockBps, unitPrice, total,
    escrowReleased, buyerRefund: escrowReleased - total, sequence,
  };
}

function applyFulfillmentFact(state, factInput) {
  const next = createMarketState(state); const fact = cloneData(factInput, 'fulfillment fact'); plain(fact, 'fulfillment fact');
  for (const field of ['tradeId', 'orderId', 'stallId', 'buyerId', 'sellerId', 'itemId']) stableId(fact[field], field);
  if (next.trades.some(trade => trade.tradeId === fact.tradeId)) fail('market.duplicate_trade', 'trade already exists', { tradeId: fact.tradeId });
  const target = order(next, fact.orderId); const selected = stall(next, fact.stallId);
  if (target.status !== 'open') fail('market.order_closed', 'order is not open', { orderId: fact.orderId });
  if (fact.buyerId !== target.buyerId || fact.sellerId !== selected.ownerId || fact.itemId !== target.itemId
      || fact.buyerId === fact.sellerId) {
    fail('market.stale_event', 'fulfillment references no longer match state');
  }
  if (!selected.categories.includes(target.category) && !roleSupports(selected, target.category)) {
    fail('market.stale_event', 'stall no longer serves the recorded order category');
  }
  safeInt(fact.sequence, 'sequence');
  if (fact.sequence >= target.expiresSequence) fail('market.order_expired', 'order has reached its expiration boundary');
  safeInt(fact.filledQuantity, 'filledQuantity', 1);
  safeInt(fact.baseUnitPrice, 'baseUnitPrice', 1);
  safeInt(fact.pricingBaseBps, 'pricingBaseBps', 1);
  safeInt(fact.pricingStockBps, 'pricingStockBps', 1);
  safeInt(fact.unitPrice, 'unitPrice', 1);
  safeInt(fact.total, 'total', 1); safeInt(fact.escrowReleased, 'escrowReleased', 1); safeInt(fact.buyerRefund, 'buyerRefund');
  if (fact.filledQuantity > target.remaining || fact.filledQuantity > getQuantity(selected.stock, target.itemId)
      || fact.unitPrice > target.limitUnitPrice
      || fact.unitPrice !== quoteUnitPrice({ baseUnitPrice: fact.baseUnitPrice, modifiersBps: [fact.pricingBaseBps, fact.pricingStockBps] })
      || fact.total !== safeMultiply(fact.filledQuantity, fact.unitPrice, 'trade total')
      || fact.escrowReleased !== safeMultiply(fact.filledQuantity, target.limitUnitPrice, 'released escrow')
      || fact.buyerRefund !== fact.escrowReleased - fact.total) {
    fail('market.stale_event', 'fulfillment fact is inconsistent with current state');
  }
  const seller = actor(next, fact.sellerId); const buyer = actor(next, fact.buyerId);
  const sellerBalance = safeAdd(seller.balance, fact.total, 'seller balance');
  const buyerBalance = safeAdd(buyer.balance, fact.buyerRefund, 'buyer balance');
  subtractQuantity(selected.stock, fact.itemId, fact.filledQuantity);
  addQuantity(buyer.items, fact.itemId, fact.filledQuantity);
  seller.balance = sellerBalance; buyer.balance = buyerBalance;
  target.remaining -= fact.filledQuantity; target.escrow -= fact.escrowReleased;
  if (target.remaining === 0) target.status = 'filled';
  next.trades.push({
    tradeId: fact.tradeId, orderId: fact.orderId, stallId: fact.stallId,
    buyerId: fact.buyerId, sellerId: fact.sellerId, itemId: fact.itemId,
    quantity: fact.filledQuantity, unitPrice: fact.unitPrice, total: fact.total, sequence: fact.sequence,
  });
  return next;
}

export function fulfillBuyOrder(state, input) {
  return applyFulfillmentFact(state, planFulfillment(state, input));
}

function planClose(state, input, status) {
  const valid = createMarketState(state); const args = cloneData(input, 'input'); plain(args, 'input');
  const target = order(valid, stableId(args.orderId, 'orderId'));
  if (target.status !== 'open') fail('market.order_closed', 'order is not open', { orderId: args.orderId });
  requireOwner(args.actorId ?? target.buyerId, target.buyerId, 'buy order');
  const sequence = safeInt(args.currentSequence ?? target.createdSequence, 'currentSequence');
  if (status === 'expired' && sequence < target.expiresSequence) fail('market.not_expired', 'order has not reached expiration');
  return { orderId: args.orderId, buyerId: target.buyerId, refund: target.escrow, status, sequence };
}
function applyCloseFact(state, factInput) {
  const next = createMarketState(state); const fact = cloneData(factInput, 'close fact'); plain(fact, 'close fact');
  const target = order(next, stableId(fact.orderId, 'orderId'));
  if (target.status !== 'open') fail('market.order_closed', 'order is not open', { orderId: fact.orderId });
  stableId(fact.buyerId, 'buyerId'); safeInt(fact.refund, 'refund'); safeInt(fact.sequence, 'sequence');
  if (!['cancelled', 'expired'].includes(fact.status) || fact.buyerId !== target.buyerId || fact.refund !== target.escrow
      || (fact.status === 'expired' && fact.sequence < target.expiresSequence)) {
    fail('market.stale_event', 'close fact is inconsistent with current state');
  }
  const buyer = actor(next, fact.buyerId);
  buyer.balance = safeAdd(buyer.balance, fact.refund, 'buyer balance');
  target.escrow = 0; target.status = fact.status;
  return next;
}
export function cancelBuyOrder(state, input) {
  const args = typeof input === 'string' ? { orderId: input } : input;
  return applyCloseFact(state, planClose(state, args, 'cancelled'));
}
export function expireBuyOrder(state, input) {
  return applyCloseFact(state, planClose(state, input, 'expired'));
}

export function marketTotals(state) {
  const valid = createMarketState(state); const items = {}; let currency = 0;
  for (const value of Object.values(valid.actorsById)) {
    currency = safeAdd(currency, value.balance, 'currency total');
    for (const [itemId, amount] of Object.entries(value.items)) addQuantity(items, itemId, amount);
  }
  for (const value of Object.values(valid.stallsById)) {
    for (const [itemId, amount] of Object.entries(value.stock)) addQuantity(items, itemId, amount);
  }
  for (const value of Object.values(valid.ordersById)) currency = safeAdd(currency, value.escrow, 'currency total');
  return { currency, items: sortedRecord(items) };
}

function commandInput(command) {
  const payload = cloneData(command.payload, 'command payload');
  plain(payload, 'command payload');
  payload.actorId = command.actorId;
  return payload;
}
function decision(operation, state, command, context, eventType) {
  try {
    const fact = operation(state.market ?? state, commandInput(command));
    return { accepted: true, events: [context.createEvent(eventType, fact)], rejection: null };
  } catch (error) {
    if (error instanceof MarketError) {
      return { accepted: false, events: [], rejection: { code: error.code, message: error.message, details: error.details } };
    }
    throw error;
  }
}
function basicHandler(operation, eventType) {
  return {
    decide(state, command, context) {
      try {
        operation(state.market ?? state, commandInput(command));
        return { accepted: true, events: [context.createEvent(eventType, commandInput(command))], rejection: null };
      } catch (error) {
        if (error instanceof MarketError) return { accepted: false, events: [], rejection: { code: error.code, message: error.message, details: error.details } };
        throw error;
      }
    },
    reduce(state, event) {
      if (own(state, 'market')) return { ...state, market: operation(state.market, event.payload) };
      return operation(state, event.payload);
    },
  };
}
function factHandler(planner, applier, eventType) {
  return {
    decide(state, command, context) {
      return decision(planner, state, command, context, eventType);
    },
    reduce(state, event) {
      if (own(state, 'market')) return { ...state, market: applier(state.market, event.payload) };
      return applier(state, event.payload);
    },
  };
}

export function createMarketHandlers() {
  const createActorHandler = basicHandler(createActor, 'market.actor_created');
  const openStallHandler = basicHandler(openStall, 'market.stall_opened');
  const placeOrderHandler = basicHandler(placeBuyOrder, 'market.buy_order_placed');
  const fulfillHandler = factHandler(planFulfillment, applyFulfillmentFact, 'market.buy_order_fulfilled');
  const cancelHandler = factHandler((state, input) => planClose(state, input, 'cancelled'), applyCloseFact, 'market.buy_order_cancelled');
  const expireHandler = factHandler((state, input) => planClose(state, input, 'expired'), applyCloseFact, 'market.buy_order_expired');
  return Object.freeze({
    'market.actor_create': createActorHandler,
    'market.stall_open': openStallHandler,
    'market.buy_order_place': placeOrderHandler,
    'market.buy_order_fulfill': fulfillHandler,
    'market.buy_order_cancel': cancelHandler,
    'market.buy_order_expire': expireHandler,
    'market.actor_created': createActorHandler,
    'market.stall_opened': openStallHandler,
    'market.buy_order_placed': placeOrderHandler,
    'market.buy_order_fulfilled': fulfillHandler,
    'market.buy_order_cancelled': cancelHandler,
  });
}
