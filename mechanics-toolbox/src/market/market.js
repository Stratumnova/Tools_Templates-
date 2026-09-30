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

function fail(code, message, details = {}) { throw new MarketError(code, message, details); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail('market.invalid_input', name + ' must be a plain object');
  return value;
}
function id(value, name) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)) {
    fail('market.invalid_input', name + ' must be a stable identifier');
  }
  return value;
}
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('market.invalid_input', name + ' must be a safe integer >= ' + minimum);
  return value;
}
function denseStrings(value, name) {
  if (!Array.isArray(value) || value.some((entry, index) => !Object.hasOwn(value, index)
      || typeof entry !== 'string' || entry.trim() === '')) fail('market.invalid_input', name + ' must be a dense string array');
  return [...new Set(value)];
}
function clone(value) {
  if (Array.isArray(value)) return value.map(entry => clone(entry));
  if (value && typeof value === 'object') {
    object(value, 'market data');
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) return value;
  fail('market.invalid_input', 'market data must contain JSON-compatible values');
}
function record(value, name) {
  object(value, name);
  for (const key of Object.keys(value)) id(key, name + ' key');
  return value;
}
function quantity(map, key) { return map[key] ?? 0; }
function add(map, key, amount) {
  const next = quantity(map, key) + amount;
  integer(next, 'resulting quantity');
  if (next === 0) delete map[key]; else map[key] = next;
}
function actor(state, actorId) {
  const result = state.actorsById[actorId];
  if (!result) fail('market.actor_not_found', 'actor does not exist', { actorId });
  return result;
}
function stall(state, stallId) {
  const result = state.stallsById[stallId];
  if (!result) fail('market.stall_not_found', 'stall does not exist', { stallId });
  return result;
}
function order(state, orderId) {
  const result = state.ordersById[orderId];
  if (!result) fail('market.order_not_found', 'order does not exist', { orderId });
  return result;
}
function sortedObject(input) {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

export function createMarketState(input = {}) {
  object(input, 'input');
  const state = {
    actorsById: clone(input.actorsById ?? {}),
    stallsById: clone(input.stallsById ?? {}),
    ordersById: clone(input.ordersById ?? {}),
    trades: clone(input.trades ?? []),
  };
  validateMarketState(state);
  return state;
}

export function validateMarketState(input) {
  object(input, 'state');
  record(input.actorsById, 'actorsById'); record(input.stallsById, 'stallsById'); record(input.ordersById, 'ordersById');
  if (!Array.isArray(input.trades)) fail('market.invalid_state', 'trades must be an array');
  for (const [actorId, value] of Object.entries(input.actorsById)) {
    object(value, 'actor'); id(actorId, 'actorId'); integer(value.balance, 'balance');
    record(value.items, 'actor items'); for (const amount of Object.values(value.items)) integer(amount, 'item quantity', 1);
  }
  for (const [stallId, value] of Object.entries(input.stallsById)) {
    object(value, 'stall'); id(stallId, 'stallId'); id(value.ownerId, 'ownerId'); actor(input, value.ownerId);
    denseStrings(value.roles, 'roles'); denseStrings(value.categories, 'categories');
    integer(value.basePriceBps, 'basePriceBps', 1); integer(value.stockPressureBps, 'stockPressureBps', 1);
    record(value.stock, 'stock'); for (const amount of Object.values(value.stock)) integer(amount, 'stock quantity', 1);
  }
  for (const [orderId, value] of Object.entries(input.ordersById)) {
    object(value, 'order'); id(orderId, 'orderId'); id(value.buyerId, 'buyerId'); id(value.itemId, 'itemId');
    integer(value.quantity, 'quantity', 1); integer(value.remaining, 'remaining');
    integer(value.limitUnitPrice, 'limitUnitPrice', 1); integer(value.escrow, 'escrow');
    if (!['open', 'filled', 'cancelled'].includes(value.status)) fail('market.invalid_state', 'invalid order status', { orderId });
    if (value.remaining > value.quantity || value.escrow > value.remaining * value.limitUnitPrice) {
      fail('market.invalid_state', 'order bounds are inconsistent', { orderId });
    }
  }
  return input;
}

export function createActor(state, input) {
  const next = createMarketState(state); const args = object(input, 'input');
  const actorId = id(args.actorId, 'actorId');
  if (next.actorsById[actorId]) fail('market.duplicate_actor', 'actor already exists', { actorId });
  integer(args.balance, 'balance');
  const items = clone(args.items ?? {}); record(items, 'items');
  for (const amount of Object.values(items)) integer(amount, 'item quantity', 1);
  next.actorsById[actorId] = { balance: args.balance, items: sortedObject(items) };
  next.actorsById = sortedObject(next.actorsById);
  return next;
}

export function openStall(state, input) {
  const next = createMarketState(state); const args = object(input, 'input');
  const stallId = id(args.stallId, 'stallId'); const ownerId = id(args.ownerId, 'ownerId'); actor(next, ownerId);
  if (next.stallsById[stallId]) fail('market.duplicate_stall', 'stall already exists', { stallId });
  const roles = denseStrings(args.roles ?? [], 'roles').sort();
  for (const role of roles) if (!Object.hasOwn(ROLE_CATEGORIES, role)) fail('market.unknown_role', 'role is not routable', { role });
  const categories = denseStrings(args.categories ?? [], 'categories').sort();
  const stock = clone(args.stock ?? {}); record(stock, 'stock');
  for (const [itemId, amount] of Object.entries(stock)) {
    integer(amount, 'stock quantity', 1);
    if (quantity(actor(next, ownerId).items, itemId) < amount) fail('market.insufficient_stock', 'owner lacks opening stock', { itemId });
    add(actor(next, ownerId).items, itemId, -amount);
  }
  next.stallsById[stallId] = {
    ownerId, roles, categories, stock: sortedObject(stock),
    basePriceBps: integer(args.basePriceBps ?? 10000, 'basePriceBps', 1),
    stockPressureBps: integer(args.stockPressureBps ?? 10000, 'stockPressureBps', 1),
  };
  next.stallsById = sortedObject(next.stallsById);
  return next;
}

export function quoteUnitPrice(input) {
  const args = object(input, 'input');
  const base = integer(args.baseUnitPrice, 'baseUnitPrice', 1);
  const modifiers = args.modifiersBps ?? [];
  if (!Array.isArray(modifiers)) fail('market.invalid_input', 'modifiersBps must be an array');
  let numerator = BigInt(base);
  let denominator = 1n;
  for (const modifier of modifiers) {
    integer(modifier, 'modifierBps', 1);
    numerator *= BigInt(modifier); denominator *= 10000n;
  }
  const rounded = (numerator + denominator / 2n) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) fail('market.price_overflow', 'quoted price exceeds safe integer range');
  return Math.max(1, Number(rounded));
}

export function placeBuyOrder(state, input) {
  const next = createMarketState(state); const args = object(input, 'input');
  const orderId = id(args.orderId, 'orderId'); const buyerId = id(args.buyerId, 'buyerId');
  id(args.itemId, 'itemId'); actor(next, buyerId);
  if (next.ordersById[orderId]) fail('market.duplicate_order', 'order already exists', { orderId });
  const quantityValue = integer(args.quantity, 'quantity', 1);
  const limitUnitPrice = integer(args.limitUnitPrice, 'limitUnitPrice', 1);
  const escrow = quantityValue * limitUnitPrice; integer(escrow, 'escrow');
  if (actor(next, buyerId).balance < escrow) fail('market.insufficient_funds', 'buyer cannot fund order', { buyerId, escrow });
  actor(next, buyerId).balance -= escrow;
  next.ordersById[orderId] = {
    buyerId, itemId: args.itemId, category: id(args.category, 'category'),
    quantity: quantityValue, remaining: quantityValue, limitUnitPrice, escrow,
    status: 'open', createdSequence: integer(args.createdSequence, 'createdSequence'),
  };
  next.ordersById = sortedObject(next.ordersById);
  return next;
}

function roleSupports(stallValue, category) {
  return stallValue.roles.some(role => ROLE_CATEGORIES[role].includes(category));
}

export function routeStalls(state, orderId) {
  const valid = createMarketState(state); const target = order(valid, id(orderId, 'orderId'));
  return Object.entries(valid.stallsById)
    .filter(([, value]) => quantity(value.stock, target.itemId) > 0
      && (value.categories.includes(target.category) || roleSupports(value, target.category)))
    .map(([stallId, value]) => ({
      stallId,
      unitPrice: quoteUnitPrice({
        baseUnitPrice: target.limitUnitPrice,
        modifiersBps: [value.basePriceBps, value.stockPressureBps],
      }),
      roleMatch: roleSupports(value, target.category),
    }))
    .filter(route => route.unitPrice <= target.limitUnitPrice)
    .sort((left, right) => Number(right.roleMatch) - Number(left.roleMatch)
      || left.unitPrice - right.unitPrice || left.stallId.localeCompare(right.stallId));
}

export function fulfillBuyOrder(state, input) {
  const next = createMarketState(state); const args = object(input, 'input');
  const target = order(next, id(args.orderId, 'orderId'));
  if (target.status !== 'open') fail('market.order_closed', 'order is not open', { orderId: args.orderId });
  const selected = stall(next, id(args.stallId, 'stallId'));
  if (!selected.categories.includes(target.category) && !roleSupports(selected, target.category)) {
    fail('market.route_rejected', 'stall does not serve order category', { stallId: args.stallId, category: target.category });
  }
  const quoted = quoteUnitPrice({
    baseUnitPrice: target.limitUnitPrice,
    modifiersBps: [selected.basePriceBps, selected.stockPressureBps],
  });
  if (quoted > target.limitUnitPrice) fail('market.price_exceeds_limit', 'quoted price exceeds order limit', { quoted });
  const requested = integer(args.quantity, 'quantity', 1);
  const filled = Math.min(requested, target.remaining, quantity(selected.stock, target.itemId));
  if (filled === 0) fail('market.no_fill', 'no quantity can be fulfilled');
  const cost = filled * quoted; integer(cost, 'trade cost', 1);
  const reservedForFill = filled * target.limitUnitPrice;
  add(selected.stock, target.itemId, -filled);
  add(actor(next, target.buyerId).items, target.itemId, filled);
  actor(next, selected.ownerId).balance += cost;
  actor(next, target.buyerId).balance += reservedForFill - cost;
  target.remaining -= filled; target.escrow -= reservedForFill;
  if (target.remaining === 0) target.status = 'filled';
  const tradeId = id(args.tradeId, 'tradeId');
  if (next.trades.some(trade => trade.tradeId === tradeId)) fail('market.duplicate_trade', 'trade already exists', { tradeId });
  next.trades.push({
    tradeId, orderId: args.orderId, stallId: args.stallId, buyerId: target.buyerId,
    sellerId: selected.ownerId, itemId: target.itemId, quantity: filled, unitPrice: quoted, total: cost,
  });
  return next;
}

export function cancelBuyOrder(state, orderId) {
  const next = createMarketState(state); const target = order(next, id(orderId, 'orderId'));
  if (target.status !== 'open') fail('market.order_closed', 'order is not open', { orderId });
  actor(next, target.buyerId).balance += target.escrow;
  target.escrow = 0; target.status = 'cancelled';
  return next;
}

export function marketTotals(state) {
  const valid = createMarketState(state); const items = {}; let currency = 0;
  for (const value of Object.values(valid.actorsById)) {
    currency += value.balance;
    for (const [itemId, amount] of Object.entries(value.items)) add(items, itemId, amount);
  }
  for (const value of Object.values(valid.stallsById)) {
    for (const [itemId, amount] of Object.entries(value.stock)) add(items, itemId, amount);
  }
  for (const value of Object.values(valid.ordersById)) currency += value.escrow;
  return { currency, items: sortedObject(items) };
}

export function createMarketHandlers() {
  const reducers = {
    'market.actor_created': (state, payload) => createActor(state, payload),
    'market.stall_opened': (state, payload) => openStall(state, payload),
    'market.buy_order_placed': (state, payload) => placeBuyOrder(state, payload),
    'market.buy_order_fulfilled': (state, payload) => fulfillBuyOrder(state, payload),
    'market.buy_order_cancelled': (state, payload) => cancelBuyOrder(state, payload.orderId),
  };
  return Object.fromEntries(Object.entries(reducers).map(([commandType, reduceOperation]) => [commandType, {
    decide(_state, command, context) {
      try { reduceOperation(_state.market ?? _state, command.payload); }
      catch (error) {
        if (error instanceof MarketError) return { accepted: false, events: [], rejection: { code: error.code, message: error.message, details: error.details } };
        throw error;
      }
      return { accepted: true, events: [context.createEvent(commandType, command.payload)], rejection: null };
    },
    reduce(state, event) {
      if (Object.hasOwn(state, 'market')) return { ...state, market: reduceOperation(state.market, event.payload) };
      return reduceOperation(state, event.payload);
    },
  }]));
}
