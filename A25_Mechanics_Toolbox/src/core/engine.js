import { accept, createCommand, createEvent, reject } from './contracts.js';
import { ERROR_CODES } from './errors.js';
import { ImmutableDataTypeError, copyImmutableData } from './immutable-data.js';

function protectedCopy(value) {
  return copyImmutableData(value, 'state');
}

function requireOptions(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options must be an object');
  if (!options.registry || typeof options.registry.get !== 'function') throw new TypeError('registry is required');
  if (!options.eventStore
      || typeof options.eventStore.append !== 'function'
      || typeof options.eventStore.beginTransaction !== 'function') {
    throw new TypeError('eventStore with append and transaction support is required');
  }
  if (!options.permissionPolicy || typeof options.permissionPolicy.allows !== 'function') throw new TypeError('permissionPolicy is required');
  if (typeof options.idFactory !== 'function') throw new TypeError('idFactory is required');
  if (typeof options.clock !== 'function') throw new TypeError('clock is required');
}

function requirePlainObject(value) {
  return value !== null && typeof value === 'object'
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireNonblankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function requireDenseArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${name} must be a dense array`);
  }
}

function validateDecision(decision) {
  if (!requirePlainObject(decision)) {
    throw new TypeError('handler decision must be a plain object');
  }
  if (decision.accepted === true) {
    requireDenseArray(decision.events, 'accepted decision events');
    if (decision.rejection !== null) {
      throw new TypeError('accepted decision must contain events and a null rejection');
    }
    return;
  }
  if (decision.accepted === false) {
    const rejection = decision.rejection;
    if (!Array.isArray(decision.events) || decision.events.length !== 0
        || !requirePlainObject(rejection)
        || !requireNonblankString(rejection.code)
        || !requireNonblankString(rejection.message)
        || !requirePlainObject(rejection.details)) {
      throw new TypeError('rejected decision must contain no events and a complete rejection');
    }
    return;
  }
  throw new TypeError('handler decision must declare accepted');
}

function appendAtomically(eventStore, events) {
  const transaction = eventStore.beginTransaction();
  if (!transaction
      || typeof transaction.append !== 'function'
      || typeof transaction.commit !== 'function'
      || typeof transaction.rollback !== 'function') {
    throw new TypeError('event store transaction must provide append, commit, and rollback');
  }
  try {
    transaction.append(events);
    transaction.commit();
  } catch (error) {
    transaction.rollback();
    throw error;
  }
}

export function createEngine(options) {
  requireOptions(options);
  const schemaVersion = options.schemaVersion ?? '1.0.0';
  let state = protectedCopy(options.initialState);
  let revision = 0;

  function dispatch(input) {
    let command;
    try {
      command = createCommand(input);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return reject(ERROR_CODES.INVALID_COMMAND, error.message, {});
    }

    if (command.expectedRevision !== revision) {
      return reject(ERROR_CODES.STALE_REVISION, 'Command revision does not match current revision', {
        expectedRevision: command.expectedRevision,
        actualRevision: revision,
      });
    }

    if (!options.permissionPolicy.allows(command.actorId, command.type)) {
      return reject(ERROR_CODES.PERMISSION_DENIED, 'Actor is not permitted to dispatch this command', {
        actorId: command.actorId,
        capability: command.type,
      });
    }

    const handler = options.registry.get(command.type);
    if (!handler) {
      return reject(ERROR_CODES.UNKNOWN_COMMAND, 'No handler is registered for this command type', {
        commandType: command.type,
      });
    }

    const factoryEvents = new WeakSet();
    const context = Object.freeze({
      commandId: command.commandId,
      actorId: command.actorId,
      roomId: command.roomId,
      createEvent(type, payload) {
        const event = createEvent({
          eventId: options.idFactory(),
          type,
          commandId: command.commandId,
          actorId: command.actorId,
          roomId: command.roomId,
          occurredAt: options.clock(),
          payload,
          schemaVersion,
        });
        factoryEvents.add(event);
        return event;
      },
    });

    const decision = handler.decide(state, command, context);
    validateDecision(decision);
    if (decision?.accepted === false) return decision;

    let events;
    try {
      events = decision.events.map(event => createEvent(event));
    } catch (error) {
      if (error instanceof ImmutableDataTypeError) throw error;
      if (!(error instanceof TypeError)) throw error;
      return reject(ERROR_CODES.INVALID_EVENT, error.message, {});
    }
    if (decision.events.some(event => !factoryEvents.has(event))) {
      return reject(ERROR_CODES.INVALID_EVENT,
        'Accepted events must be created by the current dispatch context', {});
    }

    let nextState = protectedCopy(state);
    for (const event of events) nextState = handler.reduce(nextState, event);
    nextState = protectedCopy(nextState);

    appendAtomically(options.eventStore, events);
    state = nextState;
    revision += events.length;
    return accept(events);
  }

  return Object.freeze({
    dispatch,
    getState() { return protectedCopy(state); },
    getRevision() { return revision; },
  });
}
