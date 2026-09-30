import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MarketError,
  createActor,
  createMarketHandlers,
  createMarketState,
  expireBuyOrder,
  fulfillBuyOrder,
  marketTotals,
  openStall,
  placeBuyOrder,
  routeStalls,
} from '../../src/index.js';

function fixture() {
  let state = createMarketState();
  state = createActor(state, { actorId: 'buyer', balance: 1000, items: {} });
  state = createActor(state, { actorId: 'farmer', balance: 100, items: { carrot: 10 } });
  state = openStall(state, {
    actorId: 'farmer', stallId: 'farm-stall', ownerId: 'farmer',
    roles: ['farmer'], categories: [], stock: { carrot: 10 },
    prices: { carrot: 16 }, basePriceBps: 10000, stockPressureBps: 10000,
  });
  return state;
}

test('rejects getters without executing them, cycles, sparse arrays, and inherited quantity names', () => {
  let getterRuns = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'actorsById', { enumerable: true, get() { getterRuns += 1; return {}; } });
  assert.throws(() => createMarketState(hostile), error => error instanceof MarketError);
  assert.equal(getterRuns, 0);

  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => createActor(createMarketState(), { actorId: 'a', balance: 0, items: cyclic }), MarketError);

  const roles = []; roles.length = 1;
  let state = createMarketState();
  state = createActor(state, { actorId: 'seller', balance: 0, items: {} });
  assert.throws(() => openStall(state, {
    actorId: 'seller', stallId: 's', ownerId: 'seller', roles, categories: [],
    stock: {}, prices: {},
  }), MarketError);

  state = createActor(state, { actorId: 'buyer', balance: 100, items: {} });
  assert.throws(() => placeBuyOrder(state, {
    actorId: 'buyer', orderId: 'o', buyerId: 'buyer', itemId: 'constructor',
    category: 'produce', quantity: 1, limitUnitPrice: 2, createdSequence: 1, expiresSequence: 2,
  }), error => error instanceof MarketError && error.code === 'market.invalid_input');
});

test('persisted state rejects malformed trades, duplicates, broken references, and incoherent terminals', () => {
  const state = fixture();
  assert.throws(() => createMarketState({ ...state, trades: [{ tradeId: 't' }] }), MarketError);
  const base = {
    tradeId: 't', orderId: 'o', stallId: 'farm-stall', buyerId: 'buyer',
    sellerId: 'farmer', itemId: 'carrot', quantity: 1, unitPrice: 16, total: 16,
  };
  assert.throws(() => createMarketState({ ...state, trades: [base, base] }), MarketError);

  let placed = placeBuyOrder(state, {
    actorId: 'buyer', orderId: 'o', buyerId: 'buyer', itemId: 'carrot',
    category: 'produce', quantity: 2, limitUnitPrice: 20, createdSequence: 1, expiresSequence: 10,
  });
  placed.ordersById.o.status = 'filled';
  assert.throws(() => createMarketState(placed), MarketError);
});

test('ownership prevents foreign stall fills and foreign cancellation', () => {
  let state = fixture();
  state = createActor(state, { actorId: 'intruder', balance: 100, items: {} });
  state = placeBuyOrder(state, {
    actorId: 'buyer', orderId: 'o', buyerId: 'buyer', itemId: 'carrot',
    category: 'produce', quantity: 2, limitUnitPrice: 20, createdSequence: 1, expiresSequence: 10,
  });
  assert.throws(() => fulfillBuyOrder(state, {
    actorId: 'intruder', tradeId: 't', orderId: 'o', stallId: 'farm-stall',
    quantity: 1, currentSequence: 2,
  }), error => error.code === 'market.owner_mismatch');
});

test('expiration is terminal and returns exact remaining escrow once', () => {
  let state = fixture(); const totals = marketTotals(state);
  state = placeBuyOrder(state, {
    actorId: 'buyer', orderId: 'o', buyerId: 'buyer', itemId: 'carrot',
    category: 'produce', quantity: 2, limitUnitPrice: 20, createdSequence: 1, expiresSequence: 3,
  });
  state = expireBuyOrder(state, { actorId: 'buyer', orderId: 'o', currentSequence: 3 });
  assert.equal(state.ordersById.o.status, 'expired');
  assert.equal(state.ordersById.o.escrow, 0);
  assert.deepEqual(marketTotals(state), totals);
  assert.throws(() => expireBuyOrder(state, { actorId: 'buyer', orderId: 'o', currentSequence: 4 }),
    error => error.code === 'market.order_closed');
});

test('fulfillment rejects expiration boundary, duplicate trades, and arithmetic overflow atomically', () => {
  let state = fixture();
  state = placeBuyOrder(state, {
    actorId: 'buyer', orderId: 'o', buyerId: 'buyer', itemId: 'carrot',
    category: 'produce', quantity: 2, limitUnitPrice: 20, createdSequence: 1, expiresSequence: 3,
  });
  const snapshot = structuredClone(state);
  assert.throws(() => fulfillBuyOrder(state, {
    actorId: 'farmer', tradeId: 't', orderId: 'o', stallId: 'farm-stall',
    quantity: 1, currentSequence: 3,
  }), error => error.code === 'market.order_expired');
  assert.deepEqual(state, snapshot);
});

test('fulfillment events contain resolved facts and replay never requotes', () => {
  let state = fixture();
  state = placeBuyOrder(state, {
    actorId: 'buyer', orderId: 'o', buyerId: 'buyer', itemId: 'carrot',
    category: 'produce', quantity: 2, limitUnitPrice: 20, createdSequence: 1, expiresSequence: 10,
  });
  const handlers = createMarketHandlers();
  let event;
  const decision = handlers['market.buy_order_fulfill'].decide(
    state,
    { actorId: 'farmer', payload: {
      actorId: 'farmer', tradeId: 't', orderId: 'o', stallId: 'farm-stall',
      quantity: 1, currentSequence: 2,
    } },
    { createEvent(type, payload) { event = { type, payload }; return event; } },
  );
  assert.equal(decision.accepted, true);
  assert.equal(event.type, 'market.buy_order_fulfilled');
  assert.equal(event.payload.unitPrice, 16);
  assert.equal(event.payload.filledQuantity, 1);
  const changedPricing = structuredClone(state);
  changedPricing.stallsById['farm-stall'].prices.carrot = 19;
  const replayed = handlers['market.buy_order_fulfill'].reduce(changedPricing, event);
  assert.equal(replayed.trades[0].unitPrice, 16);
});

test('self-trade, handler payload accessors, and hidden mutation are rejected', () => {
  let state = fixture();
  state = placeBuyOrder(state, {
    actorId: 'buyer', orderId: 'o', buyerId: 'buyer', itemId: 'carrot',
    category: 'produce', quantity: 2, limitUnitPrice: 20, createdSequence: 1, expiresSequence: 10,
  });

  let getterRuns = 0;
  const payload = {};
  Object.defineProperty(payload, 'orderId', {
    enumerable: true,
    get() { getterRuns += 1; return 'o'; },
  });
  const result = createMarketHandlers()['market.buy_order_fulfill'].decide(
    state,
    { actorId: 'farmer', payload },
    { createEvent() { throw new Error('must not emit'); } },
  );
  assert.equal(result.accepted, false);
  assert.equal(getterRuns, 0);
});

test('self-trade is rejected when buyer owns eligible stock', () => {
  let state = createMarketState();
  state = createActor(state, { actorId: 'buyer', balance: 100, items: { carrot: 2 } });
  state = openStall(state, {
    actorId: 'buyer', stallId: 'buyer-stall', ownerId: 'buyer',
    roles: ['farmer'], categories: [], stock: { carrot: 2 }, prices: { carrot: 10 },
  });
  state = placeBuyOrder(state, {
    actorId: 'buyer', orderId: 'o', buyerId: 'buyer', itemId: 'carrot',
    category: 'produce', quantity: 1, limitUnitPrice: 20, createdSequence: 1, expiresSequence: 10,
  });
  assert.throws(() => fulfillBuyOrder(state, {
    actorId: 'buyer', tradeId: 'self-trade', orderId: 'o',
    stallId: 'buyer-stall', quantity: 1, currentSequence: 2,
  }), error => error.code === 'market.self_trade');
});

test('caller mutation cannot alter accepted state and unroutable items return no route', () => {
  const items = { carrot: 2 };
  let state = createMarketState();
  state = createActor(state, { actorId: 'seller', balance: 0, items });
  items.carrot = 999;
  assert.equal(state.actorsById.seller.items.carrot, 2);

  state = createActor(state, { actorId: 'buyer', balance: 100, items: {} });
  state = openStall(state, {
    actorId: 'seller', stallId: 's', ownerId: 'seller', roles: [], categories: [],
    stock: { carrot: 2 }, prices: { carrot: 10 },
  });
  state = placeBuyOrder(state, {
    actorId: 'buyer', orderId: 'o', buyerId: 'buyer', itemId: 'carrot',
    category: 'unknown', quantity: 1, limitUnitPrice: 20,
    createdSequence: 1, expiresSequence: 10,
  });
  assert.deepEqual(routeStalls(state, 'o'), []);
});

test('persisted trade totals must agree with order remainder', () => {
  let state = fixture();
  state = placeBuyOrder(state, {
    actorId: 'buyer', orderId: 'o', buyerId: 'buyer', itemId: 'carrot',
    category: 'produce', quantity: 2, limitUnitPrice: 20,
    createdSequence: 1, expiresSequence: 10,
  });
  state = fulfillBuyOrder(state, {
    actorId: 'farmer', tradeId: 't', orderId: 'o', stallId: 'farm-stall',
    quantity: 1, currentSequence: 2,
  });
  const corrupt = structuredClone(state);
  corrupt.ordersById.o.remaining = 2;
  corrupt.ordersById.o.escrow = 40;
  assert.throws(() => createMarketState(corrupt), error => error.code === 'market.invalid_state');
});
