import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MarketError, cancelBuyOrder, createActor, createMarketState, fulfillBuyOrder,
  marketTotals, openStall, placeBuyOrder, quoteUnitPrice, routeStalls,
} from '../../src/index.js';

function fixture() {
  let state = createMarketState();
  state = createActor(state, { actorId: 'buyer', balance: 1000, items: {} });
  state = createActor(state, { actorId: 'farmer', balance: 100, items: { carrot: 10 } });
  state = createActor(state, { actorId: 'beast-keeper', balance: 50, items: { feed: 8 } });
  state = openStall(state, {
    stallId: 'farm-stall', ownerId: 'farmer', roles: ['farmer'], categories: [],
    stock: { carrot: 10 }, basePriceBps: 8000, stockPressureBps: 10000,
  });
  state = openStall(state, {
    stallId: 'beast-stall', ownerId: 'beast-keeper', roles: ['beast_master'], categories: [],
    stock: { feed: 8 }, basePriceBps: 9000, stockPressureBps: 10000,
  });
  return state;
}

test('pricing uses integer basis points and deterministic half-up rounding', () => {
  assert.equal(quoteUnitPrice({ baseUnitPrice: 101, modifiersBps: [5000] }), 51);
  assert.equal(quoteUnitPrice({ baseUnitPrice: 100, modifiersBps: [8000, 12500] }), 100);
});

test('farmer and beast master roles route only supported categories', () => {
  let state = fixture();
  state = placeBuyOrder(state, {
    orderId: 'order-carrot', buyerId: 'buyer', itemId: 'carrot', category: 'produce',
    quantity: 3, limitUnitPrice: 20, createdSequence: 1,
  });
  assert.deepEqual(routeStalls(state, 'order-carrot'), [
    { stallId: 'farm-stall', unitPrice: 16, roleMatch: true },
  ]);
});

test('partial fulfillment conserves money and items and refunds price improvement', () => {
  let state = fixture(); const before = marketTotals(state);
  state = placeBuyOrder(state, {
    orderId: 'order-carrot', buyerId: 'buyer', itemId: 'carrot', category: 'produce',
    quantity: 7, limitUnitPrice: 20, createdSequence: 1,
  });
  state = fulfillBuyOrder(state, {
    tradeId: 'trade-1', orderId: 'order-carrot', stallId: 'farm-stall', quantity: 3,
  });
  assert.equal(state.ordersById['order-carrot'].remaining, 4);
  assert.equal(state.ordersById['order-carrot'].escrow, 80);
  assert.equal(state.actorsById.buyer.items.carrot, 3);
  assert.equal(state.actorsById.buyer.balance, 872);
  assert.equal(state.actorsById.farmer.balance, 148);
  assert.deepEqual(marketTotals(state), before);
});

test('multiple fills close the order without minting value', () => {
  let state = fixture(); const before = marketTotals(state);
  state = placeBuyOrder(state, {
    orderId: 'order-carrot', buyerId: 'buyer', itemId: 'carrot', category: 'produce',
    quantity: 5, limitUnitPrice: 20, createdSequence: 1,
  });
  state = fulfillBuyOrder(state, {
    tradeId: 'trade-1', orderId: 'order-carrot', stallId: 'farm-stall', quantity: 2,
  });
  state = fulfillBuyOrder(state, {
    tradeId: 'trade-2', orderId: 'order-carrot', stallId: 'farm-stall', quantity: 99,
  });
  assert.equal(state.ordersById['order-carrot'].status, 'filled');
  assert.equal(state.ordersById['order-carrot'].escrow, 0);
  assert.deepEqual(marketTotals(state), before);
});

test('cancellation refunds only unspent escrow', () => {
  let state = fixture(); const before = marketTotals(state);
  state = placeBuyOrder(state, {
    orderId: 'order-carrot', buyerId: 'buyer', itemId: 'carrot', category: 'produce',
    quantity: 4, limitUnitPrice: 20, createdSequence: 1,
  });
  state = fulfillBuyOrder(state, {
    tradeId: 'trade-1', orderId: 'order-carrot', stallId: 'farm-stall', quantity: 1,
  });
  state = cancelBuyOrder(state, 'order-carrot');
  assert.equal(state.ordersById['order-carrot'].status, 'cancelled');
  assert.equal(state.ordersById['order-carrot'].escrow, 0);
  assert.deepEqual(marketTotals(state), before);
});

test('failure is atomic because operations clone before mutation', () => {
  const state = fixture(); const snapshot = structuredClone(state);
  assert.throws(() => placeBuyOrder(state, {
    orderId: 'bad-order', buyerId: 'buyer', itemId: 'carrot', category: 'produce',
    quantity: 100, limitUnitPrice: 100, createdSequence: 1,
  }), error => error instanceof MarketError && error.code === 'market.insufficient_funds');
  assert.deepEqual(state, snapshot);
});
