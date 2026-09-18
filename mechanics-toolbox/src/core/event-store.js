import { copyImmutableData } from './immutable-data.js';

function protectedCopy(value) {
  return copyImmutableData(value, 'event');
}

export function createEventStore(initialEvents = []) {
  if (!Array.isArray(initialEvents)) throw new TypeError('initialEvents must be an array');
  const events = initialEvents.map(protectedCopy);

  function beginTransaction() {
    const staged = [];
    let active = true;

    function requireActive() {
      if (!active) throw new Error('event store transaction is closed');
    }

    return Object.freeze({
      append(newEvents) {
        requireActive();
        if (!Array.isArray(newEvents)) throw new TypeError('events must be an array');
        const copies = newEvents.map(protectedCopy);
        staged.push(...copies);
      },
      commit() {
        requireActive();
        events.push(...staged);
        active = false;
      },
      rollback() {
        requireActive();
        staged.length = 0;
        active = false;
      },
    });
  }

  return Object.freeze({
    beginTransaction,
    append(newEvents) {
      const transaction = beginTransaction();
      try {
        transaction.append(newEvents);
        transaction.commit();
      } catch (error) {
        transaction.rollback();
        throw error;
      }
    },
    getEvents() {
      return Object.freeze(events.map(protectedCopy));
    },
  });
}
