export function createSeededRng(seed) {
  if (!Number.isInteger(seed)) {
    throw new TypeError('seed must be an integer');
  }

  let state = seed >>> 0;

  function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  function int(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new TypeError('min and max must be integers');
    }
    if (min > max) {
      throw new RangeError('min must not exceed max');
    }
    return Math.floor(next() * (max - min + 1)) + min;
  }

  function pick(array) {
    if (!Array.isArray(array)) {
      throw new TypeError('array must be an array');
    }
    if (array.length === 0) {
      throw new RangeError('array must not be empty');
    }
    return array[int(0, array.length - 1)];
  }

  function snapshot() {
    return state >>> 0;
  }

  return Object.freeze({ next, int, pick, snapshot });
}
