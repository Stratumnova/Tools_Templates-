import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ERROR_CODES,
  accept,
  createCommand,
  createEngine,
  createEvent,
  createEventStore,
  createIdFactory,
  createPermissionPolicy,
  createRegistry,
  reject,
} from '../../src/index.js';

const makeCommand = (overrides = {}) => createCommand({
  commandId: 'cmd-1',
  type: 'counter.increment',
  actorId: 'actor-1',
  roomId: 'room-1',
  issuedAt: 10,
  payload: { amount: 1 },
  expectedRevision: 0,
  ...overrides,
});

const counterHandler = {
  decide(_state, command, context) {
    return accept([context.createEvent('counter.incremented', { amount: command.payload.amount })]);
  },
  reduce(state, event) {
    return { ...state, count: state.count + event.payload.amount };
  },
};

function makeEngine({
  handler = counterHandler,
  grants = { 'actor-1': ['counter.increment'] },
  idFactory = createIdFactory('evt', 0),
  clock = () => 25,
} = {}) {
  const registry = createRegistry();
  registry.register('counter.increment', handler);
  const eventStore = createEventStore();
  const engine = createEngine({
    initialState: { count: 0 },
    registry,
    eventStore,
    permissionPolicy: createPermissionPolicy(grants),
    idFactory,
    clock,
  });
  return { engine, eventStore, registry };
}

test('accepted dispatch stores and reduces an event with deterministic metadata', () => {
  const { engine, eventStore } = makeEngine();

  const result = engine.dispatch(makeCommand());

  assert.equal(result.accepted, true);
  assert.deepEqual(result.events, [{
    eventId: 'evt-000001', type: 'counter.incremented', commandId: 'cmd-1',
    actorId: 'actor-1', roomId: 'room-1', occurredAt: 25,
    payload: { amount: 1 }, schemaVersion: '1.0.0',
  }]);
  assert.deepEqual(engine.getState(), { count: 1 });
  assert.equal(engine.getRevision(), 1);
  assert.deepEqual(eventStore.getEvents(), result.events);
});

test('stale revision is rejected before decision and leaves engine unchanged', () => {
  let decisions = 0;
  const handler = { ...counterHandler, decide(...args) { decisions += 1; return counterHandler.decide(...args); } };
  const { engine, eventStore } = makeEngine({ handler });

  const result = engine.dispatch(makeCommand({ expectedRevision: 3 }));

  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, ERROR_CODES.STALE_REVISION);
  assert.equal(decisions, 0);
  assert.deepEqual(engine.getState(), { count: 0 });
  assert.equal(engine.getRevision(), 0);
  assert.deepEqual(eventStore.getEvents(), []);
});

test('unknown command returns a stable rejection', () => {
  const { engine } = makeEngine({ grants: { 'actor-1': ['*'] } });
  const result = engine.dispatch(makeCommand({ type: 'counter.unknown' }));

  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, ERROR_CODES.UNKNOWN_COMMAND);
  assert.deepEqual(engine.getState(), { count: 0 });
});

test('permissions deny missing grants and allow wildcard grants', () => {
  const denied = makeEngine({ grants: { 'actor-1': ['something.else'] } });
  const deniedResult = denied.engine.dispatch(makeCommand());
  assert.equal(deniedResult.rejection.code, ERROR_CODES.PERMISSION_DENIED);
  assert.deepEqual(denied.eventStore.getEvents(), []);

  const allowed = makeEngine({ grants: { 'actor-1': ['*'] } });
  assert.equal(allowed.engine.dispatch(makeCommand()).accepted, true);
  assert.equal(allowed.engine.getRevision(), 1);

  const unknownActor = makeEngine({ grants: { 'someone-else': ['*'] } });
  assert.equal(unknownActor.engine.dispatch(makeCommand()).rejection.code, ERROR_CODES.PERMISSION_DENIED);
});

test('decision and store failures preserve published state and revision', () => {
  const decisionFailure = makeEngine({
    handler: { ...counterHandler, decide() { throw new Error('decision failed'); } },
  });
  assert.throws(() => decisionFailure.engine.dispatch(makeCommand()), /decision failed/);
  assert.deepEqual(decisionFailure.engine.getState(), { count: 0 });
  assert.equal(decisionFailure.engine.getRevision(), 0);
  assert.deepEqual(decisionFailure.eventStore.getEvents(), []);

});

test('a store that partially appends then throws is rolled back', () => {
  const retained = [];
  const eventStore = {
    append(events) {
      retained.push(events[0]);
      throw new Error('store failed after partial append');
    },
    beginTransaction() {
      const startingLength = retained.length;
      return {
        append(events) { retained.push(events[0]); },
        commit() { throw new Error('store failed after partial append'); },
        rollback() { retained.length = startingLength; },
      };
    },
    getEvents() { return [...retained]; },
  };
  const registry = createRegistry();
  registry.register('counter.increment', counterHandler);
  const engine = createEngine({
    initialState: { count: 0 },
    registry,
    eventStore,
    permissionPolicy: createPermissionPolicy({ 'actor-1': ['counter.increment'] }),
    idFactory: createIdFactory('evt', 0),
    clock: () => 25,
  });

  assert.throws(() => engine.dispatch(makeCommand()), /store failed after partial append/);
  assert.deepEqual(eventStore.getEvents(), []);
  assert.deepEqual(engine.getState(), { count: 0 });
  assert.equal(engine.getRevision(), 0);
});

test('rolling back an external stale transaction preserves a later engine commit', () => {
  const { engine, eventStore } = makeEngine();
  const stale = eventStore.beginTransaction();
  stale.append([{ eventId: 'external-staged' }]);

  assert.equal(engine.dispatch(makeCommand()).accepted, true);
  stale.rollback();

  assert.deepEqual(engine.getState(), { count: 1 });
  assert.equal(engine.getRevision(), 1);
  assert.deepEqual(eventStore.getEvents().map(event => event.eventId), ['evt-000001']);
});

test('engine rejects an event store without the transaction boundary', () => {
  const registry = createRegistry();
  registry.register('counter.increment', counterHandler);

  assert.throws(() => createEngine({
    initialState: { count: 0 },
    registry,
    eventStore: { append() {} },
    permissionPolicy: createPermissionPolicy({ 'actor-1': ['counter.increment'] }),
    idFactory: createIdFactory('evt', 0),
    clock: () => 25,
  }), /transaction/);
});

test('malformed accepted and rejected decisions throw without mutation', () => {
  for (const decision of [
    { accepted: false },
    { accepted: false, events: [], rejection: null },
    { accepted: true, events: [], rejection: { code: 'NOPE', message: 'bad', details: {} } },
  ]) {
    const { engine, eventStore } = makeEngine({
      handler: { ...counterHandler, decide: () => decision },
    });

    assert.throws(() => engine.dispatch(makeCommand()), /decision/);
    assert.deepEqual(eventStore.getEvents(), []);
    assert.deepEqual(engine.getState(), { count: 0 });
    assert.equal(engine.getRevision(), 0);
  }
});

test('sparse accepted event arrays throw before reduction or mutation', () => {
  for (const hole of ['start', 'middle', 'end']) {
    let reductions = 0;
    const handler = {
      decide(_state, _command, context) {
        const first = context.createEvent('counter.incremented', { amount: 1 });
        const second = context.createEvent('counter.incremented', { amount: 2 });
        if (hole === 'start') return { accepted: true, events: [, first], rejection: null };
        if (hole === 'middle') return { accepted: true, events: [first, , second], rejection: null };
        return { accepted: true, events: [first, second, ,], rejection: null };
      },
      reduce(state) { reductions += 1; return state; },
    };
    const { engine, eventStore } = makeEngine({ handler });

    assert.throws(() => engine.dispatch(makeCommand()), /dense/);
    assert.equal(reductions, 0);
    assert.deepEqual(engine.getState(), { count: 0 });
    assert.equal(engine.getRevision(), 0);
    assert.deepEqual(eventStore.getEvents(), []);
  }
});

test('handler rejection passes through without mutation', () => {
  const rejection = reject('INSUFFICIENT_RESOURCE', 'Not enough resource', { available: 0 });
  const { engine, eventStore } = makeEngine({ handler: { ...counterHandler, decide: () => rejection } });

  const result = engine.dispatch(makeCommand());

  assert.equal(result, rejection);
  assert.deepEqual(engine.getState(), { count: 0 });
  assert.equal(engine.getRevision(), 0);
  assert.deepEqual(eventStore.getEvents(), []);
});

test('malformed emitted event is rejected without mutation', () => {
  const handler = { ...counterHandler, decide: () => accept([{ type: 'broken' }]) };
  const { engine, eventStore } = makeEngine({ handler });

  const result = engine.dispatch(makeCommand());

  assert.equal(result.rejection.code, ERROR_CODES.INVALID_EVENT);
  assert.deepEqual(engine.getState(), { count: 0 });
  assert.equal(engine.getRevision(), 0);
  assert.deepEqual(eventStore.getEvents(), []);
});

test('externally created events with forged provenance are rejected without mutation', () => {
  const base = {
    eventId: 'evt-000001',
    type: 'counter.incremented',
    commandId: 'cmd-1',
    actorId: 'actor-1',
    roomId: 'room-1',
    occurredAt: 25,
    payload: { amount: 1 },
    schemaVersion: '1.0.0',
  };
  const forgeries = [
    { eventId: 'forged-id' },
    { commandId: 'forged-command' },
    { actorId: 'forged-actor' },
    { roomId: 'forged-room' },
    { occurredAt: 999 },
    { schemaVersion: '9.9.9' },
  ];

  for (const forgedFields of forgeries) {
    let idCalls = 0;
    let clockCalls = 0;
    const forged = createEvent({ ...base, ...forgedFields });
    const handler = { ...counterHandler, decide: () => accept([forged]) };
    const { engine, eventStore } = makeEngine({
      handler,
      idFactory() { idCalls += 1; return `evt-${idCalls}`; },
      clock() { clockCalls += 1; return 25; },
    });

    const result = engine.dispatch(makeCommand());

    assert.equal(result.accepted, false);
    assert.equal(result.rejection.code, ERROR_CODES.INVALID_EVENT);
    assert.equal(idCalls, 0);
    assert.equal(clockCalls, 0);
    assert.deepEqual(engine.getState(), { count: 0 });
    assert.equal(engine.getRevision(), 0);
    assert.deepEqual(eventStore.getEvents(), []);
  }
});

test('clones of context-created events are rejected without mutation', () => {
  let idCalls = 0;
  let clockCalls = 0;
  const handler = {
    ...counterHandler,
    decide(_state, _command, context) {
      const event = context.createEvent('counter.incremented', { amount: 1 });
      return accept([{ ...event }]);
    },
  };
  const { engine, eventStore } = makeEngine({
    handler,
    idFactory() { idCalls += 1; return `evt-${idCalls}`; },
    clock() { clockCalls += 1; return 25; },
  });

  const result = engine.dispatch(makeCommand());

  assert.equal(result.accepted, false);
  assert.equal(result.rejection.code, ERROR_CODES.INVALID_EVENT);
  assert.equal(idCalls, 1);
  assert.equal(clockCalls, 1);
  assert.deepEqual(engine.getState(), { count: 0 });
  assert.equal(engine.getRevision(), 0);
  assert.deepEqual(eventStore.getEvents(), []);
});

test('unsupported command payloads return INVALID_COMMAND without mutation', () => {
  const cycle = {};
  cycle.self = cycle;
  const unsupported = [
    new Map([['key', 'value']]),
    new Set(['value']),
    new Date(0),
    () => 1,
    cycle,
  ];

  for (const value of unsupported) {
    const { engine, eventStore } = makeEngine();
    const result = engine.dispatch({
      commandId: 'cmd-invalid',
      type: 'counter.increment',
      actorId: 'actor-1',
      roomId: 'room-1',
      issuedAt: 10,
      payload: { nested: value },
      expectedRevision: 0,
    });

    assert.equal(result.accepted, false);
    assert.equal(result.rejection.code, ERROR_CODES.INVALID_COMMAND);
    assert.deepEqual(engine.getState(), { count: 0 });
    assert.equal(engine.getRevision(), 0);
    assert.deepEqual(eventStore.getEvents(), []);
  }
});

test('unsupported emitted payloads throw TypeError without mutation', () => {
  const cycle = {};
  cycle.self = cycle;
  const unsupported = [
    new Map([['key', 'value']]),
    new Set(['value']),
    new Date(0),
    () => 1,
    cycle,
  ];

  for (const value of unsupported) {
    const handler = {
      ...counterHandler,
      decide() {
        return accept([{
          eventId: 'evt-handler',
          type: 'counter.incremented',
          commandId: 'cmd-1',
          actorId: 'actor-1',
          roomId: 'room-1',
          occurredAt: 25,
          payload: { nested: value },
          schemaVersion: '1.0.0',
        }]);
      },
    };
    const { engine, eventStore } = makeEngine({ handler });

    assert.throws(() => engine.dispatch(makeCommand()), TypeError);
    assert.deepEqual(engine.getState(), { count: 0 });
    assert.equal(engine.getRevision(), 0);
    assert.deepEqual(eventStore.getEvents(), []);
  }
});

test('a later reducer failure publishes and appends no temporary work', () => {
  const handler = {
    decide(_state, _command, context) {
      return accept([
        context.createEvent('counter.incremented', { amount: 1 }),
        context.createEvent('counter.exploded', { amount: 100 }),
      ]);
    },
    reduce(state, event) {
      if (event.type === 'counter.exploded') throw new Error('reducer failed');
      return { count: state.count + event.payload.amount };
    },
  };
  const { engine, eventStore } = makeEngine({ handler });

  assert.throws(() => engine.dispatch(makeCommand()), /reducer failed/);
  assert.deepEqual(engine.getState(), { count: 0 });
  assert.equal(engine.getRevision(), 0);
  assert.deepEqual(eventStore.getEvents(), []);
});

test('event arrays and store snapshots cannot mutate the log', () => {
  const { engine, eventStore } = makeEngine();
  const result = engine.dispatch(makeCommand());
  const snapshot = eventStore.getEvents();

  assert.equal(Object.isFrozen(result.events), true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot[0]), true);
  assert.throws(() => result.events.push({}), TypeError);
  assert.throws(() => snapshot.pop(), TypeError);
  assert.throws(() => { snapshot[0].payload.amount = 99; }, TypeError);
  assert.equal(eventStore.getEvents()[0].payload.amount, 1);
});

test('nested event payloads are isolated and immutable during reduction and after return', () => {
  const callerPayload = { nested: { values: [1, 2] } };
  let reducerMutationBlocked = false;
  const handler = {
    decide(_state, _command, context) {
      return accept([context.createEvent('counter.incremented', callerPayload)]);
    },
    reduce(state, event) {
      assert.equal(Object.isFrozen(event.payload.nested), true);
      assert.equal(Object.isFrozen(event.payload.nested.values), true);
      assert.throws(() => { event.payload.nested.values[0] = 99; }, TypeError);
      reducerMutationBlocked = true;
      return { ...state, count: state.count + event.payload.nested.values[0] };
    },
  };
  const { engine, eventStore } = makeEngine({ handler });

  const result = engine.dispatch(makeCommand());
  callerPayload.nested.values[0] = 77;

  assert.equal(reducerMutationBlocked, true);
  assert.equal(Object.isFrozen(callerPayload), false);
  assert.equal(Object.isFrozen(callerPayload.nested), false);
  assert.throws(() => { result.events[0].payload.nested.values.push(3); }, TypeError);
  assert.deepEqual(result.events[0].payload, { nested: { values: [1, 2] } });
  assert.deepEqual(eventStore.getEvents()[0].payload, { nested: { values: [1, 2] } });
});

test('own __proto__ payload keys survive reduction, results, and event-store snapshots', () => {
  const payload = JSON.parse('{"__proto__":{"top":true},"nested":{"__proto__":{"deep":true}}}');
  const handler = {
    decide(_state, _command, context) {
      return accept([context.createEvent('counter.incremented', payload)]);
    },
    reduce(state, event) {
      assert.equal(Object.hasOwn(event.payload, '__proto__'), true);
      assert.equal(Object.hasOwn(event.payload.nested, '__proto__'), true);
      return { ...state, seen: [event.payload.__proto__.top, event.payload.nested.__proto__.deep] };
    },
  };
  const { engine, eventStore } = makeEngine({ handler });

  const result = engine.dispatch(makeCommand({ payload }));
  const snapshot = eventStore.getEvents();

  assert.deepEqual(engine.getState(), { count: 0, seen: [true, true] });
  for (const event of [result.events[0], snapshot[0]]) {
    assert.equal(Object.getPrototypeOf(event.payload), Object.prototype);
    assert.equal(Object.hasOwn(event.payload, '__proto__'), true);
    assert.deepEqual(event.payload.__proto__, { top: true });
    assert.equal(Object.getPrototypeOf(event.payload.nested), Object.prototype);
    assert.equal(Object.hasOwn(event.payload.nested, '__proto__'), true);
    assert.deepEqual(event.payload.nested.__proto__, { deep: true });
    assert.equal(event.payload.top, undefined);
    assert.equal(event.payload.nested.deep, undefined);
  }
});

test('registry rejects invalid and duplicate registrations', () => {
  const registry = createRegistry();
  registry.register('counter.increment', counterHandler);

  assert.throws(() => registry.register('counter.increment', counterHandler), /already registered/);
  assert.throws(() => registry.register('', counterHandler), TypeError);
  assert.throws(() => registry.register('missing.decide', { reduce() {} }), TypeError);
  assert.throws(() => registry.register('missing.reduce', { decide() {} }), TypeError);
});

test('registry snapshots immutable handler function references', () => {
  const registry = createRegistry();
  const originalDecide = () => accept([]);
  const originalReduce = state => state;
  const handler = { decide: originalDecide, reduce: originalReduce };
  registry.register('counter.increment', handler);

  handler.decide = () => { throw new Error('mutated decide'); };
  handler.reduce = () => { throw new Error('mutated reduce'); };
  const registered = registry.get('counter.increment');

  assert.notEqual(registered, handler);
  assert.equal(Object.isFrozen(registered), true);
  assert.equal(registered.decide, originalDecide);
  assert.equal(registered.reduce, originalReduce);
  assert.throws(() => { registered.decide = handler.decide; }, TypeError);
});

test('zero-event acceptance does not increment revision', () => {
  const handler = { ...counterHandler, decide: () => accept([]) };
  const { engine, eventStore } = makeEngine({ handler });

  const result = engine.dispatch(makeCommand());

  assert.equal(result.accepted, true);
  assert.deepEqual(result.events, []);
  assert.deepEqual(engine.getState(), { count: 0 });
  assert.equal(engine.getRevision(), 0);
  assert.deepEqual(eventStore.getEvents(), []);
});

test('multi-event acceptance increments revision once per event', () => {
  let idCalls = 0;
  let clockCalls = 0;
  const handler = {
    ...counterHandler,
    decide(_state, _command, context) {
      return accept([
        context.createEvent('counter.incremented', { amount: 1 }),
        context.createEvent('counter.incremented', { amount: 2 }),
      ]);
    },
  };
  const { engine } = makeEngine({
    handler,
    idFactory() { idCalls += 1; return `evt-${idCalls}`; },
    clock() { clockCalls += 1; return 20 + clockCalls; },
  });

  assert.equal(engine.dispatch(makeCommand()).accepted, true);
  assert.deepEqual(engine.getState(), { count: 3 });
  assert.equal(engine.getRevision(), 2);
  assert.equal(idCalls, 2);
  assert.equal(clockCalls, 2);
});

test('handler context is frozen and command-bound', () => {
  let seenContext;
  const handler = {
    ...counterHandler,
    decide(_state, _command, context) { seenContext = context; return accept([]); },
  };
  const { engine } = makeEngine({ handler });

  engine.dispatch(makeCommand());

  assert.equal(Object.isFrozen(seenContext), true);
  assert.equal(seenContext.commandId, 'cmd-1');
  assert.equal(seenContext.actorId, 'actor-1');
  assert.equal(seenContext.roomId, 'room-1');
  assert.throws(() => { seenContext.actorId = 'other'; }, TypeError);
});
