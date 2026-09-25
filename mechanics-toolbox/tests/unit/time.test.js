import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceClock, createClock, nextScheduleOccurrence } from '../../src/index.js';

test('clock creation and advancement are immutable and integer-safe', () => {
  const clock = createClock(10);
  const advanced = advanceClock(clock, 5);
  assert.deepEqual(clock, { now: 10 });
  assert.deepEqual(advanced, { now: 15 });
  assert.notEqual(advanced, clock);
  assert.equal(Object.isFrozen(clock), true);
  for (const value of [-1, 1.5, Infinity, NaN]) assert.throws(() => createClock(value), TypeError);
  for (const value of [-1, 1.5, Infinity, NaN]) assert.throws(() => advanceClock(clock, value), TypeError);
  assert.throws(() => advanceClock(createClock(Number.MAX_SAFE_INTEGER), 1), RangeError);
});

test('schedule finds strict next occurrences arithmetically across boundaries and large jumps', () => {
  const schedule = { scheduleId: 'shift.day', startAt: 10, everyMs: 5, endAt: 30 };
  assert.equal(nextScheduleOccurrence(schedule, 0), 10);
  assert.equal(nextScheduleOccurrence(schedule, 10), 15);
  assert.equal(nextScheduleOccurrence(schedule, 29), 30);
  assert.equal(nextScheduleOccurrence(schedule, 30), null);
  assert.equal(nextScheduleOccurrence({ scheduleId: 'large', startAt: 3, everyMs: 7 }, 7_000_000_000_001), 7_000_000_000_003);
});

test('schedule rejects invalid definitions and unsafe calculations', () => {
  const valid = { scheduleId: 'shift', startAt: 0, everyMs: 1 };
  for (const schedule of [
    { ...valid, scheduleId: 'bad id' }, { ...valid, startAt: -1 }, { ...valid, everyMs: 0 },
    { ...valid, everyMs: 1.5 }, { ...valid, endAt: -1 }, { ...valid, endAt: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => nextScheduleOccurrence(schedule, 0));
  assert.throws(() => nextScheduleOccurrence(valid, -1), TypeError);
  assert.throws(() => nextScheduleOccurrence({ ...valid, startAt: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER), RangeError);
});
