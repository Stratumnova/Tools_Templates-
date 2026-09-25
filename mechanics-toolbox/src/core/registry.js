import { requireStableIdentifier } from './identifiers.js';

function requireCommandType(commandType) {
  requireStableIdentifier(commandType, 'commandType');
}

function requireHandler(handler) {
  if (handler === null || typeof handler !== 'object') {
    throw new TypeError('handler must be an object');
  }
  if (typeof handler.decide !== 'function' || typeof handler.reduce !== 'function') {
    throw new TypeError('handler must provide decide and reduce functions');
  }
}

export function createRegistry() {
  const handlers = new Map();

  return Object.freeze({
    register(commandType, handler) {
      requireCommandType(commandType);
      requireHandler(handler);
      if (handlers.has(commandType)) {
        throw new RangeError(`command type already registered: ${commandType}`);
      }
      handlers.set(commandType, Object.freeze({
        decide: handler.decide,
        reduce: handler.reduce,
      }));
    },
    get(commandType) {
      return handlers.get(commandType);
    },
    has(commandType) {
      return handlers.has(commandType);
    },
  });
}
