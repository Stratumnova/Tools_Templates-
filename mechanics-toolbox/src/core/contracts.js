import { requireStableIdentifier } from './identifiers.js';
import { copyImmutableData } from './immutable-data.js';

function requireNonblankString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a nonblank string`);
  }
}

function requireFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function requirePlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

export function createCommand(fields) {
  requirePlainObject(fields, 'fields');
  for (const name of ['commandId', 'type', 'actorId', 'roomId']) {
    requireStableIdentifier(fields[name], name);
  }
  requireFiniteNumber(fields.issuedAt, 'issuedAt');
  requirePlainObject(fields.payload, 'payload');
  if (!Number.isInteger(fields.expectedRevision) || fields.expectedRevision < 0) {
    throw new TypeError('expectedRevision must be a non-negative integer');
  }

  return Object.freeze({
    commandId: fields.commandId,
    type: fields.type,
    actorId: fields.actorId,
    roomId: fields.roomId,
    issuedAt: fields.issuedAt,
    payload: copyImmutableData(fields.payload, 'payload'),
    expectedRevision: fields.expectedRevision,
  });
}

export function createEvent(fields) {
  requirePlainObject(fields, 'fields');
  for (const name of ['eventId', 'type', 'commandId', 'actorId', 'roomId', 'schemaVersion']) {
    if (name === 'schemaVersion') requireNonblankString(fields[name], name);
    else requireStableIdentifier(fields[name], name);
  }
  requireFiniteNumber(fields.occurredAt, 'occurredAt');
  requirePlainObject(fields.payload, 'payload');

  return Object.freeze({
    eventId: fields.eventId,
    type: fields.type,
    commandId: fields.commandId,
    actorId: fields.actorId,
    roomId: fields.roomId,
    occurredAt: fields.occurredAt,
    payload: copyImmutableData(fields.payload, 'payload'),
    schemaVersion: fields.schemaVersion,
  });
}

export function accept(events) {
  if (!Array.isArray(events)) {
    throw new TypeError('events must be an array');
  }
  return { accepted: true, events: Object.freeze([...events]), rejection: null };
}

export function reject(code, message, details) {
  requireNonblankString(code, 'code');
  requireNonblankString(message, 'message');
  requirePlainObject(details, 'details');

  return {
    accepted: false,
    events: Object.freeze([]),
    rejection: { code, message, details: copyImmutableData(details, 'details') },
  };
}
