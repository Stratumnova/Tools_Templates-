export function createIdFactory(prefix, start) {
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new TypeError('prefix must be a nonblank string');
  }
  if (!Number.isInteger(start) || start < 0) {
    throw new TypeError('start must be a non-negative integer');
  }

  let sequence = start;
  return function nextId() {
    sequence += 1;
    return `${prefix}-${String(sequence).padStart(6, '0')}`;
  };
}
