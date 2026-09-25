import { inventoryError, validatedClone } from '../resources/definitions.js';
import { accept, reject } from '../core/contracts.js';
import {
  addItem, damageDurability, inventoryInternals, removeItem, transferItem,
} from './inventory.js';
import { isStableIdentifier } from '../core/identifiers.js';

function requireId(value, name) {
  if (!isStableIdentifier(value)) throw inventoryError('inventory.invalid_input', `${name} must be a stable identifier`);
}

function requireArgs(input, functionKeys = []) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError('input must be an object');
  }
  const data = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`input.${String(key)} must be an enumerable data property`);
    }
    if (functionKeys.includes(key)) {
      if (typeof descriptor.value !== 'function') throw new TypeError(`input.${key} must be a function`);
    } else Object.defineProperty(data, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  const args = validatedClone(data, 'input');
  if (!args || Array.isArray(args) || typeof args !== 'object') throw new TypeError('input must be an object');
  return args;
}

function stateCopy(state) {
  return inventoryInternals.validateState(state);
}

export function reserveQuantity(state, input) {
  const next = stateCopy(state); const args = requireArgs(input);
  requireId(args.reservationId, 'reservationId'); requireId(args.containerId, 'containerId'); requireId(args.itemId, 'itemId');
  if (!Number.isInteger(args.quantity) || args.quantity <= 0) throw inventoryError('inventory.invalid_input', 'quantity must be positive');
  if (Object.hasOwn(next.reservationsById, args.reservationId)) {
    throw inventoryError('inventory.duplicate_reservation', 'reservation ID already exists', { reservationId: args.reservationId });
  }
  const container = Object.hasOwn(next.containersById, args.containerId) ? next.containersById[args.containerId] : undefined;
  if (!container) throw inventoryError('inventory.container_not_found', 'container does not exist');
  const alreadyReserved = inventoryInternals.reservedByStack(next, args.containerId);
  let remaining = args.quantity; const allocations = [];
  for (const stack of container.stacks) {
    if (stack.itemId !== args.itemId || remaining === 0) continue;
    const amount = Math.min(remaining, stack.quantity - (alreadyReserved.get(stack.stackId) ?? 0));
    if (amount > 0) {
      allocations.push({
        stackId: stack.stackId, quantity: amount, quality: stack.quality,
        durability: stack.durability, metadata: validatedClone(stack.metadata, 'metadata'),
      });
      remaining -= amount;
    }
  }
  if (remaining > 0) throw inventoryError('inventory.insufficient_available', 'not enough unreserved quantity');
  next.reservationsById[args.reservationId] = {
    reservationId: args.reservationId, containerId: args.containerId, itemId: args.itemId,
    quantity: args.quantity, allocations,
  };
  return next;
}

function applyReservation(state, record) {
  const next = stateCopy(state);
  if (Object.hasOwn(next.reservationsById, record.reservationId)) {
    throw inventoryError('inventory.duplicate_reservation', 'reservation ID already exists', { reservationId: record.reservationId });
  }
  next.reservationsById[record.reservationId] = validatedClone(record, 'reservation');
  return stateCopy(next);
}

export function releaseReservation(state, reservationId) {
  const next = stateCopy(state); requireId(reservationId, 'reservationId');
  if (!Object.hasOwn(next.reservationsById, reservationId)) throw inventoryError('inventory.reservation_not_found', 'reservation does not exist');
  delete next.reservationsById[reservationId];
  return next;
}

export function consumeReservation(state, reservationId) {
  const next = stateCopy(state); requireId(reservationId, 'reservationId');
  const reservation = Object.hasOwn(next.reservationsById, reservationId) ? next.reservationsById[reservationId] : undefined;
  if (!reservation) throw inventoryError('inventory.reservation_not_found', 'reservation does not exist');
  const container = next.containersById[reservation.containerId];
  for (const allocation of reservation.allocations) {
    const stack = container?.stacks.find(candidate => candidate.stackId === allocation.stackId);
    if (!stack || stack.itemId !== reservation.itemId || stack.quantity < allocation.quantity
        || stack.quality !== allocation.quality || stack.durability !== allocation.durability
        || !inventoryInternals.structuralEqual(stack.metadata, allocation.metadata)) {
      throw inventoryError('inventory.reservation_conflict', 'reserved stack no longer matches its allocation');
    }
  }
  for (const allocation of reservation.allocations) {
    container.stacks.find(stack => stack.stackId === allocation.stackId).quantity -= allocation.quantity;
  }
  container.stacks = container.stacks.filter(stack => stack.quantity > 0);
  delete next.reservationsById[reservationId];
  return next;
}

function idCollector(factory) {
  const ids = [];
  return { ids, next() { const value = factory(); ids.push(value); return value; } };
}

function idIterator(ids) {
  let index = 0;
  return () => ids[index++];
}

export function createInventoryHandlers(options) {
  const config = requireArgs(options, ['nextStackId']);
  if (!options.definitionsById || typeof options.definitionsById !== 'object' || typeof options.nextStackId !== 'function') {
    throw new TypeError('definitionsById and nextStackId are required');
  }
  const definitionsById = config.definitionsById;
  const definitionFor = itemId => Object.hasOwn(definitionsById, itemId) ? definitionsById[itemId] : undefined;
  const decide = operation => (state, command, context) => {
    try {
      const result = operation(state, command.payload);
      return accept([context.createEvent(result.type, result.payload)]);
    } catch (error) {
      if (!error?.code?.startsWith('inventory.')) throw error;
      return reject(error.code, error.message, error.details ?? {});
    }
  };
  const reducer = operation => (state, event) => operation(state, event.payload);

  return {
    'inventory.add': {
      decide: decide((state, payload) => {
        const generated = idCollector(options.nextStackId);
        addItem(state, { ...payload, definition: definitionFor(payload.itemId), definitionsById, nextStackId: () => generated.next() });
        return { type: 'inventory.item_added', payload: { ...payload, stackIds: generated.ids } };
      }),
      reduce: reducer((state, payload) => addItem(state, {
        ...payload, definition: definitionFor(payload.itemId), definitionsById,
        nextStackId: idIterator(payload.stackIds),
      })),
    },
    'inventory.remove': {
      decide: decide((state, payload) => {
        removeItem(state, payload);
        return { type: 'inventory.item_removed', payload };
      }),
      reduce: reducer(removeItem),
    },
    'inventory.transfer': {
      decide: decide((state, payload) => {
        const generated = idCollector(options.nextStackId);
        transferItem(state, { ...payload, definition: definitionFor(payload.itemId), definitionsById, nextStackId: () => generated.next() });
        return { type: 'inventory.item_transferred', payload: { ...payload, stackIds: generated.ids } };
      }),
      reduce: reducer((state, payload) => transferItem(state, {
        ...payload, definition: definitionFor(payload.itemId), definitionsById,
        nextStackId: idIterator(payload.stackIds),
      })),
    },
    'inventory.damage_durability': {
      decide: decide((state, payload) => {
        const container = Object.hasOwn(state.containersById, payload.containerId)
          ? state.containersById[payload.containerId] : undefined;
        const itemId = container?.stacks.find(stack => stack.stackId === payload.stackId)?.itemId;
        const generated = idCollector(options.nextStackId);
        const damageInput = { ...payload, definitionsById, nextStackId: () => generated.next() };
        if (itemId !== undefined) damageInput.definition = definitionFor(itemId);
        const result = damageDurability(state, damageInput);
        return {
          type: result.event?.type ?? 'inventory.durability_damaged',
          payload: {
            ...payload, itemId,
            ...(result.event ? { quantity: result.event.payload.quantity } : {}),
            stackIds: generated.ids,
          },
        };
      }),
      reduce: reducer((state, payload) => damageDurability(state, {
        ...payload, definition: definitionFor(payload.itemId), definitionsById,
        nextStackId: idIterator(payload.stackIds),
      }).state),
    },
    'inventory.reserve': {
      decide: decide((state, payload) => {
        const next = reserveQuantity(state, payload);
        const record = next.reservationsById[payload.reservationId];
        return { type: 'inventory.quantity_reserved', payload: record };
      }),
      reduce: reducer(applyReservation),
    },
    'inventory.release_reservation': {
      decide: decide((state, payload) => {
        releaseReservation(state, payload.reservationId);
        return { type: 'inventory.reservation_released', payload };
      }),
      reduce: reducer((state, payload) => releaseReservation(state, payload.reservationId)),
    },
    'inventory.consume_reservation': {
      decide: decide((state, payload) => {
        const record = stateCopy(state).reservationsById[payload.reservationId];
        consumeReservation(state, payload.reservationId);
        return { type: 'inventory.reservation_consumed', payload: record };
      }),
      reduce: reducer((state, payload) => consumeReservation(state, payload.reservationId)),
    },
  };
}
