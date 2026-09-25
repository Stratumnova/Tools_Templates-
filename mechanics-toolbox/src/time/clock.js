function requireTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
}

export function createClock(now) {
  requireTimestamp(now, 'now');
  return Object.freeze({ now });
}

export function advanceClock(clock, deltaMs) {
  if (!clock || Array.isArray(clock) || Object.getPrototypeOf(clock) !== Object.prototype) {
    throw new TypeError('clock must be a plain object');
  }
  requireTimestamp(clock.now, 'clock.now');
  requireTimestamp(deltaMs, 'deltaMs');
  const now = clock.now + deltaMs;
  if (!Number.isSafeInteger(now)) throw new RangeError('clock advancement exceeds the safe integer range');
  return createClock(now);
}

export const clockInternals = Object.freeze({ requireTimestamp });
