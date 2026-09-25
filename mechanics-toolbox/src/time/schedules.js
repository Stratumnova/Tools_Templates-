import { requireStableIdentifier } from '../core/identifiers.js';
import { clockInternals } from './clock.js';

export function nextScheduleOccurrence(schedule, after) {
  if (!schedule || Array.isArray(schedule) || Object.getPrototypeOf(schedule) !== Object.prototype) {
    throw new TypeError('schedule must be a plain object');
  }
  requireStableIdentifier(schedule.scheduleId, 'scheduleId');
  clockInternals.requireTimestamp(schedule.startAt, 'startAt');
  clockInternals.requireTimestamp(after, 'after');
  if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs <= 0) {
    throw new TypeError('everyMs must be a positive safe integer');
  }
  if (Object.hasOwn(schedule, 'endAt')) {
    clockInternals.requireTimestamp(schedule.endAt, 'endAt');
    if (schedule.endAt < schedule.startAt) throw new RangeError('endAt must not precede startAt');
  }
  let next = schedule.startAt;
  if (after >= next) {
    const steps = Math.floor((after - next) / schedule.everyMs) + 1;
    next += steps * schedule.everyMs;
  }
  if (!Number.isSafeInteger(next)) throw new RangeError('schedule occurrence exceeds the safe integer range');
  return Object.hasOwn(schedule, 'endAt') && next > schedule.endAt ? null : next;
}
