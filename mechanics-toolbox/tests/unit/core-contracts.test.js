import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ERROR_CODES,
  accept,
  createCommand,
  createEvent,
  createIdFactory,
  reject,
} from '../../src/index.js';

const commandFields = {
  commandId: 'cmd-1', type: 'gather', actorId: 'actor-1', roomId: 'wild',
  issuedAt: 12.5, payload: { itemId: 'wood' }, expectedRevision: 0,
};

const eventFields = {
  eventId: 'evt-1', type: 'gathered', commandId: 'cmd-1', actorId: 'actor-1',
  roomId: 'wild', occurredAt: 13, payload: { quantity: 1 }, schemaVersion: '1.0.0',
};

test('createCommand copies and freezes the command payload without freezing caller data', () => {
  const payload = { itemId: 'wood' };
  const command = createCommand({ ...commandFields, payload });

  assert.deepEqual(command, { ...commandFields, payload: { itemId: 'wood' } });
  assert.equal(Object.isFrozen(command), true);
  assert.equal(Object.isFrozen(command.payload), true);
  assert.equal(Object.isFrozen(payload), false);
  assert.notEqual(command.payload, payload);
});

test('createCommand rejects invalid identifiers, timestamps, payloads, and revisions', () => {
  for (const key of ['commandId', 'type', 'actorId', 'roomId']) {
    assert.throws(() => createCommand({ ...commandFields, [key]: '   ' }), TypeError);
  }
  for (const issuedAt of [NaN, Infinity, '12']) {
    assert.throws(() => createCommand({ ...commandFields, issuedAt }), TypeError);
  }
  for (const payload of [null, [], new Date(), Object.create(null)]) {
    assert.throws(() => createCommand({ ...commandFields, payload }), TypeError);
  }
  for (const expectedRevision of [-1, 1.5, '0']) {
    assert.throws(() => createCommand({ ...commandFields, expectedRevision }), TypeError);
  }
});

test('createEvent validates its fields and returns an immutable copy', () => {
  const payload = { quantity: 1 };
  const event = createEvent({ ...eventFields, payload });

  assert.deepEqual(event, { ...eventFields, payload: { quantity: 1 } });
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.equal(Object.isFrozen(payload), false);
  for (const key of ['eventId', 'type', 'commandId', 'actorId', 'roomId', 'schemaVersion']) {
    assert.throws(() => createEvent({ ...eventFields, [key]: '' }), TypeError);
  }
  assert.throws(() => createEvent({ ...eventFields, occurredAt: -Infinity }), TypeError);
  assert.throws(() => createEvent({ ...eventFields, payload: [] }), TypeError);
});

test('command and event payloads reject values outside the JSON-like data domain', () => {
  class CustomValue {}
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() { getterCalls += 1; return 1; },
  });
  const cycle = {};
  cycle.self = cycle;

  const unsupported = [
    new Map([['key', 'value']]),
    new Set(['value']),
    new Date(0),
    () => 1,
    undefined,
    1n,
    Symbol('value'),
    new Uint8Array([1]),
    new CustomValue(),
    accessor,
    cycle,
    NaN,
    Infinity,
  ];

  for (const value of unsupported) {
    assert.throws(() => createCommand({
      ...commandFields,
      payload: { nested: value },
    }), TypeError);
    assert.throws(() => createEvent({
      ...eventFields,
      payload: { nested: value },
    }), TypeError);
  }
  assert.equal(getterCalls, 0);
});

test('valid nested payloads are copied and deeply frozen without freezing caller data', () => {
  const payload = { values: [null, true, 'text', 3.5, { nested: ['ok'] }] };
  const event = createEvent({ ...eventFields, payload });

  assert.deepEqual(event.payload, payload);
  assert.notEqual(event.payload, payload);
  assert.notEqual(event.payload.values, payload.values);
  assert.equal(Object.isFrozen(event.payload.values), true);
  assert.equal(Object.isFrozen(event.payload.values[4]), true);
  assert.equal(Object.isFrozen(event.payload.values[4].nested), true);
  assert.equal(Object.isFrozen(payload), false);
  assert.equal(Object.isFrozen(payload.values), false);
});

test('command and event copies preserve own __proto__ data properties safely', () => {
  const payload = JSON.parse('{"__proto__":{"top":true},"nested":{"__proto__":{"deep":true}}}');

  for (const record of [
    createCommand({ ...commandFields, payload }),
    createEvent({ ...eventFields, payload }),
  ]) {
    assert.equal(Object.getPrototypeOf(record.payload), Object.prototype);
    assert.equal(Object.hasOwn(record.payload, '__proto__'), true);
    assert.deepEqual(record.payload.__proto__, { top: true });
    assert.equal(Object.getPrototypeOf(record.payload.nested), Object.prototype);
    assert.equal(Object.hasOwn(record.payload.nested, '__proto__'), true);
    assert.deepEqual(record.payload.nested.__proto__, { deep: true });
    assert.equal(record.payload.top, undefined);
    assert.equal(record.payload.nested.deep, undefined);
  }
});

test('accept copies and freezes the event array', () => {
  const events = [{ eventId: 'evt-1' }];
  const result = accept(events);

  assert.deepEqual(result, { accepted: true, events: [{ eventId: 'evt-1' }], rejection: null });
  assert.equal(Object.isFrozen(result.events), true);
  assert.notEqual(result.events, events);
  assert.throws(() => accept('not-an-array'), TypeError);
});

test('reject validates rejection fields and protects caller-owned details', () => {
  const details = { field: 'actorId' };
  const result = reject('INVALID_COMMAND', 'Actor is required', details);

  assert.deepEqual(result, {
    accepted: false,
    events: [],
    rejection: { code: 'INVALID_COMMAND', message: 'Actor is required', details: { field: 'actorId' } },
  });
  assert.equal(Object.isFrozen(result.events), true);
  assert.throws(() => result.events.push({ eventId: 'evt-invalid' }), TypeError);
  assert.equal(Object.isFrozen(result.rejection.details), true);
  assert.equal(Object.isFrozen(details), false);
  assert.throws(() => reject('', 'message', {}), TypeError);
  assert.throws(() => reject('CODE', ' ', {}), TypeError);
  assert.throws(() => reject('CODE', 'message', []), TypeError);
});

test('public error codes are stable and immutable', () => {
  assert.deepEqual(ERROR_CODES, {
    INVALID_COMMAND: 'INVALID_COMMAND',
    INVALID_EVENT: 'INVALID_EVENT',
    INVALID_ARGUMENT: 'INVALID_ARGUMENT',
    UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
    STALE_REVISION: 'STALE_REVISION',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
  });
  assert.equal(Object.isFrozen(ERROR_CODES), true);
});

test('createIdFactory creates deterministic padded IDs and validates configuration', () => {
  const nextEventId = createIdFactory('evt', 0);
  assert.equal(nextEventId(), 'evt-000001');
  assert.equal(nextEventId(), 'evt-000002');
  assert.equal(createIdFactory('cmd', 41)(), 'cmd-000042');
  assert.throws(() => createIdFactory(' ', 0), TypeError);
  assert.throws(() => createIdFactory('evt', -1), TypeError);
  assert.throws(() => createIdFactory('evt', 1.5), TypeError);
});
