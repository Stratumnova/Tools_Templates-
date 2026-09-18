import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventStore } from '../../src/index.js';

test('transactions keep staged batches private and publish them in commit order', () => {
  const store = createEventStore();
  const first = store.beginTransaction();
  const second = store.beginTransaction();

  first.append([{ eventId: 'first' }]);
  second.append([{ eventId: 'second' }]);
  assert.deepEqual(store.getEvents(), []);

  second.commit();
  first.commit();

  assert.deepEqual(store.getEvents(), [{ eventId: 'second' }, { eventId: 'first' }]);
});

test('rolling back a stale overlapping transaction cannot erase a later commit', () => {
  const store = createEventStore();
  const stale = store.beginTransaction();
  stale.append([{ eventId: 'stale' }]);
  const later = store.beginTransaction();
  later.append([{ eventId: 'later' }]);

  later.commit();
  stale.rollback();

  assert.deepEqual(store.getEvents(), [{ eventId: 'later' }]);
});
