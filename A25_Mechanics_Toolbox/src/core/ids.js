import { requireStableIdentifier } from './identifiers.js';

export function createIdFactory(prefix, start) {
  requireStableIdentifier(prefix, 'prefix');
  if (!Number.isInteger(start) || start < 0) {
    throw new TypeError('start must be a non-negative integer');
  }

  let sequence = start;
  return function nextId() {
    sequence += 1;
    return `${prefix}-${String(sequence).padStart(6, '0')}`;
  };
}
