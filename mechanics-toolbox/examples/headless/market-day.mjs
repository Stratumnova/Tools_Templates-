import {
  createActor, createMarketState, fulfillBuyOrder, marketTotals,
  openStall, placeBuyOrder, routeStalls,
} from '../../src/index.js';

let market = createMarketState();
market = createActor(market, { actorId: 'traveler', balance: 500, items: {} });
market = createActor(market, { actorId: 'farmer-rhea', balance: 0, items: { carrot: 12 } });
market = openStall(market, {
  stallId: 'rheas-produce', ownerId: 'farmer-rhea', roles: ['farmer'], categories: [],
  stock: { carrot: 12 }, basePriceBps: 8500, stockPressureBps: 10000,
});
const openingTotals = marketTotals(market);
market = placeBuyOrder(market, {
  orderId: 'lunch-order', buyerId: 'traveler', itemId: 'carrot', category: 'produce',
  quantity: 5, limitUnitPrice: 20, createdSequence: 1,
});
const [route] = routeStalls(market, 'lunch-order');
market = fulfillBuyOrder(market, {
  tradeId: 'trade-lunch-1', orderId: 'lunch-order', stallId: route.stallId, quantity: 2,
});
market = fulfillBuyOrder(market, {
  tradeId: 'trade-lunch-2', orderId: 'lunch-order', stallId: route.stallId, quantity: 3,
});
console.log(JSON.stringify({
  routes: routeStalls(placeBuyOrder(openStall(createActor(createActor(createMarketState(),
    { actorId: 'traveler', balance: 500, items: {} }),
    { actorId: 'farmer-rhea', balance: 0, items: { carrot: 12 } }),
    { stallId: 'rheas-produce', ownerId: 'farmer-rhea', roles: ['farmer'], categories: [],
      stock: { carrot: 12 }, basePriceBps: 8500, stockPressureBps: 10000 }),
    { orderId: 'lunch-order', buyerId: 'traveler', itemId: 'carrot', category: 'produce',
      quantity: 5, limitUnitPrice: 20, createdSequence: 1 }), 'lunch-order'),
  market, conserved: JSON.stringify(openingTotals) === JSON.stringify(marketTotals(market)),
}, null, 2));
