import {
  accept,
  createCommand,
  createEngine,
  createEventStore,
  createIdFactory,
  createPermissionPolicy,
  createRegistry,
} from '../../src/index.js';

const registry = createRegistry();
registry.register('counter.increment', {
  decide(_state, command, context) {
    return accept([context.createEvent('counter.incremented', command.payload)]);
  },
  reduce(state, event) {
    return { count: state.count + event.payload.amount };
  },
});

const engine = createEngine({
  initialState: { count: 0 },
  registry,
  eventStore: createEventStore(),
  permissionPolicy: createPermissionPolicy({ player: ['counter.increment'] }),
  idFactory: createIdFactory('evt', 0),
  clock: () => 1000,
});

engine.dispatch(createCommand({
  commandId: 'cmd-1',
  type: 'counter.increment',
  actorId: 'player',
  roomId: 'headless',
  issuedAt: 999,
  payload: { amount: 1 },
  expectedRevision: 0,
}));

console.log(`revision=${engine.getRevision()} count=${engine.getState().count}`);
