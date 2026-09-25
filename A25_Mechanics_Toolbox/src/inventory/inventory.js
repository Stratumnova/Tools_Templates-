import {
  inventoryError, validateItemDefinition, validatedClone,
} from '../resources/definitions.js';
import { isStableIdentifier } from '../core/identifiers.js';

function requireObject(value, name, functionKeys = []) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const data = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${name} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`${name}.${key} must be a data property`);
    if (functionKeys.includes(key)) {
      if (typeof descriptor.value !== 'function') throw new TypeError(`${name}.${key} must be a function`);
    } else {
      Object.defineProperty(data, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
    }
  }
  const copy = validatedClone(data, name);
  if (!copy || Array.isArray(copy) || typeof copy !== 'object') throw new TypeError(`${name} must be a plain object`);
  return copy;
}

function requireId(value, name) {
  if (!isStableIdentifier(value)) {
    throw inventoryError('inventory.invalid_input', `${name} must be a stable identifier`);
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw inventoryError('inventory.invalid_input', `${name} must be a positive integer`);
  }
}

function validateState(state) {
  const copy = requireObject(state, 'state');
  const invalid = (message, details = {}) => { throw inventoryError('inventory.invalid_state', message, details); };
  if (!copy.containersById || Array.isArray(copy.containersById) || typeof copy.containersById !== 'object'
      || !copy.reservationsById || Array.isArray(copy.reservationsById) || typeof copy.reservationsById !== 'object') {
    invalid('state must contain container and reservation maps');
  }
  const stacksById = new Map();
  for (const [id, container] of Object.entries(copy.containersById)) {
    if (!isStableIdentifier(id) || !container || Array.isArray(container) || container.containerId !== id
        || !Number.isInteger(container.capacity) || container.capacity < 0 || !Array.isArray(container.stacks)) {
      invalid('container is invalid', { containerId: id });
    }
    let total = 0;
    for (const stack of container.stacks) {
      if (!stack || Array.isArray(stack)
          || !isStableIdentifier(stack.stackId)
          || !isStableIdentifier(stack.itemId)
          || !Number.isInteger(stack.quantity) || stack.quantity <= 0) invalid('stack is invalid', { containerId: id });
      if (!Object.hasOwn(stack, 'quality') || !Object.hasOwn(stack, 'durability')
          || !stack.metadata || Array.isArray(stack.metadata) || typeof stack.metadata !== 'object') {
        invalid('stack traits are invalid', { stackId: stack.stackId });
      }
      if (stacksById.has(stack.stackId)) invalid('stack IDs must be globally unique', { stackId: stack.stackId });
      stacksById.set(stack.stackId, { containerId: id, stack });
      total += stack.quantity;
    }
    if (total > container.capacity) invalid('container quantity exceeds capacity', { containerId: id });
  }
  const reservedById = new Map();
  for (const [id, reservation] of Object.entries(copy.reservationsById)) {
    if (!isStableIdentifier(id) || !reservation || Array.isArray(reservation) || reservation.reservationId !== id
        || !isStableIdentifier(reservation.containerId)
        || !isStableIdentifier(reservation.itemId)
        || !Number.isInteger(reservation.quantity) || reservation.quantity <= 0
        || !Array.isArray(reservation.allocations) || reservation.allocations.length === 0) {
      invalid('reservation is invalid', { reservationId: id });
    }
    const container = Object.hasOwn(copy.containersById, reservation.containerId) ? copy.containersById[reservation.containerId] : undefined;
    if (!container) invalid('reservation container does not exist', { reservationId: id });
    const allocationIds = new Set(); let allocated = 0;
    for (const allocation of reservation.allocations) {
      if (!allocation || Array.isArray(allocation)
          || !isStableIdentifier(allocation.stackId)
          || !Number.isInteger(allocation.quantity) || allocation.quantity <= 0
          || !Object.hasOwn(allocation, 'quality') || !Object.hasOwn(allocation, 'durability')
          || !allocation.metadata || Array.isArray(allocation.metadata) || typeof allocation.metadata !== 'object') {
        invalid('reservation allocation is invalid', { reservationId: id });
      }
      if (allocationIds.has(allocation.stackId)) invalid('reservation allocations must be unique', { reservationId: id });
      allocationIds.add(allocation.stackId);
      const entry = stacksById.get(allocation.stackId);
      if (!entry || entry.containerId !== reservation.containerId
          || entry.stack.itemId !== reservation.itemId
          || entry.stack.quality !== allocation.quality
          || entry.stack.durability !== allocation.durability
          || !structuralEqual(entry.stack.metadata, allocation.metadata)) {
        invalid('reservation allocation does not match its stack', { reservationId: id, stackId: allocation.stackId });
      }
      allocated += allocation.quantity;
      reservedById.set(allocation.stackId, (reservedById.get(allocation.stackId) ?? 0) + allocation.quantity);
    }
    if (allocated !== reservation.quantity) invalid('reservation allocation total must equal quantity', { reservationId: id });
  }
  for (const [stackId, quantity] of reservedById) {
    if (quantity > stacksById.get(stackId).stack.quantity) invalid('reserved quantity exceeds physical quantity', { stackId });
  }
  return copy;
}

function getContainer(state, containerId) {
  requireId(containerId, 'containerId');
  const container = Object.hasOwn(state.containersById, containerId) ? state.containersById[containerId] : undefined;
  if (!container) throw inventoryError('inventory.container_not_found', 'container does not exist', { containerId });
  return container;
}

function totalQuantity(container) {
  return container.stacks.reduce((sum, stack) => sum + stack.quantity, 0);
}

function structuralEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((value, index) => structuralEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left); const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => (
    Object.hasOwn(right, key) && structuralEqual(left[key], right[key])
  ));
}

function isCompatible(stack, traits) {
  return stack.itemId === traits.itemId && stack.quality === traits.quality
    && stack.durability === traits.durability && structuralEqual(stack.metadata, traits.metadata);
}

function reservedByStack(state, containerId) {
  const totals = new Map();
  for (const reservation of Object.values(state.reservationsById)) {
    if (reservation.containerId !== containerId) continue;
    for (const allocation of reservation.allocations) {
      totals.set(allocation.stackId, (totals.get(allocation.stackId) ?? 0) + allocation.quantity);
    }
  }
  return totals;
}

function addTraits(state, containerId, traits, quantity, definition, nextStackId) {
  const container = getContainer(state, containerId);
  if (totalQuantity(container) + quantity > container.capacity) {
    throw inventoryError('inventory.capacity_exceeded', 'container capacity would be exceeded', { containerId });
  }
  let remaining = quantity;
  for (const stack of container.stacks) {
    if (!isCompatible(stack, traits)) continue;
    const amount = Math.min(remaining, definition.stackLimit - stack.quantity);
    if (amount > 0) { stack.quantity += amount; remaining -= amount; }
    if (remaining === 0) return state;
  }
  while (remaining > 0) {
    if (typeof nextStackId !== 'function') throw inventoryError('inventory.invalid_input', 'nextStackId is required');
    const stackId = nextStackId(); requireId(stackId, 'generated stackId');
    if (Object.values(state.containersById).some(candidate => (
      candidate.stacks.some(stack => stack.stackId === stackId)
    ))) {
      throw inventoryError('inventory.duplicate_stack', 'generated stack ID already exists', { stackId });
    }
    const amount = Math.min(remaining, definition.stackLimit);
    container.stacks.push({ stackId, ...validatedClone(traits, 'stack traits'), quantity: amount });
    remaining -= amount;
  }
  return state;
}

export function addItem(state, input) {
  const next = validateState(state); const args = requireObject(input, 'input', ['nextStackId']);
  const definition = validateItemDefinition(args.definition, { definitionsById: args.definitionsById });
  requireId(args.itemId, 'itemId'); requirePositiveInteger(args.quantity, 'quantity');
  if (args.itemId !== definition.itemId) throw inventoryError('inventory.definition_mismatch', 'definition does not match item');
  if (!Object.hasOwn(args, 'quality') || !Object.hasOwn(args, 'durability')) {
    throw inventoryError('inventory.invalid_input', 'quality and durability are required');
  }
  if (definition.durability.enabled) {
    if (!Number.isInteger(args.durability) || args.durability <= 0 || args.durability > definition.durability.max) {
      throw inventoryError('inventory.invalid_input', 'durability is outside the definition range');
    }
  } else if (args.durability !== null) throw inventoryError('inventory.invalid_input', 'non-durable items use null durability');
  const metadata = requireObject(args.metadata, 'metadata');
  return addTraits(next, args.containerId, {
    itemId: args.itemId, quality: args.quality, durability: args.durability, metadata,
  }, args.quantity, definition, input.nextStackId);
}

function removeAvailable(state, containerId, itemId, quantity, includeReserved = false) {
  const container = getContainer(state, containerId); const reserved = reservedByStack(state, containerId);
  const physical = container.stacks.reduce((sum, stack) => sum + (stack.itemId === itemId ? stack.quantity : 0), 0);
  const available = container.stacks.reduce((sum, stack) => sum + (stack.itemId === itemId
    ? stack.quantity - (includeReserved ? 0 : (reserved.get(stack.stackId) ?? 0)) : 0), 0);
  if (available < quantity) {
    throw inventoryError(includeReserved || physical < quantity
      ? 'inventory.insufficient_quantity' : 'inventory.insufficient_available',
      'not enough item quantity is available', { containerId, itemId, available });
  }
  let remaining = quantity;
  for (let index = 0; index < container.stacks.length && remaining > 0; index += 1) {
    const stack = container.stacks[index];
    if (stack.itemId !== itemId) continue;
    const amount = Math.min(remaining, stack.quantity - (includeReserved ? 0 : (reserved.get(stack.stackId) ?? 0)));
    stack.quantity -= amount; remaining -= amount;
  }
  container.stacks = container.stacks.filter(stack => stack.quantity > 0);
  return state;
}

export function removeItem(state, input) {
  const next = validateState(state); const args = requireObject(input, 'input');
  requireId(args.itemId, 'itemId'); requirePositiveInteger(args.quantity, 'quantity');
  return removeAvailable(next, args.containerId, args.itemId, args.quantity, false);
}

export function transferItem(state, input) {
  const next = validateState(state); const args = requireObject(input, 'input', ['nextStackId']);
  const definition = validateItemDefinition(args.definition, { definitionsById: args.definitionsById });
  requireId(args.itemId, 'itemId'); requirePositiveInteger(args.quantity, 'quantity');
  if (args.itemId !== definition.itemId) throw inventoryError('inventory.definition_mismatch', 'definition does not match item');
  const source = getContainer(next, args.sourceContainerId); const target = getContainer(next, args.targetContainerId);
  if (source === target) throw inventoryError('inventory.invalid_input', 'source and target must differ');
  if (totalQuantity(target) + args.quantity > target.capacity) {
    throw inventoryError('inventory.capacity_exceeded', 'target capacity would be exceeded', { containerId: target.containerId });
  }
  const reserved = reservedByStack(next, source.containerId); let remaining = args.quantity; const portions = [];
  const available = source.stacks.reduce((sum, stack) => sum + (stack.itemId === args.itemId
    ? stack.quantity - (reserved.get(stack.stackId) ?? 0) : 0), 0);
  if (available < remaining) throw inventoryError('inventory.insufficient_available', 'not enough unreserved quantity', { available });
  for (const stack of source.stacks) {
    if (stack.itemId !== args.itemId || remaining === 0) continue;
    const amount = Math.min(remaining, stack.quantity - (reserved.get(stack.stackId) ?? 0));
    if (amount > 0) {
      portions.push({ quantity: amount, traits: {
        itemId: stack.itemId, quality: stack.quality, durability: stack.durability, metadata: stack.metadata,
      } });
      stack.quantity -= amount; remaining -= amount;
    }
  }
  source.stacks = source.stacks.filter(stack => stack.quantity > 0);
  for (const portion of portions) addTraits(next, target.containerId, portion.traits, portion.quantity, definition, input.nextStackId);
  return next;
}

export function damageDurability(state, input) {
  let next = validateState(state); const args = requireObject(input, 'input', ['nextStackId']);
  const definition = validateItemDefinition(args.definition, { definitionsById: args.definitionsById });
  requireId(args.stackId, 'stackId'); requirePositiveInteger(args.amount, 'amount');
  const container = getContainer(next, args.containerId);
  const stack = container.stacks.find(candidate => candidate.stackId === args.stackId);
  if (!stack) throw inventoryError('inventory.stack_not_found', 'stack does not exist', { stackId: args.stackId });
  if (stack.itemId !== definition.itemId || !definition.durability.enabled) {
    throw inventoryError('inventory.invalid_input', 'item is not damageable with this definition');
  }
  if (reservedByStack(next, container.containerId).get(stack.stackId)) {
    throw inventoryError('inventory.reservation_conflict', 'reserved stacks cannot be damaged');
  }
  if (args.amount < stack.durability) {
    stack.durability -= args.amount;
    return { state: next, event: null };
  }
  const quantity = stack.quantity;
  container.stacks = container.stacks.filter(candidate => candidate.stackId !== stack.stackId);
  if (definition.durability.breakPolicy === 'scrap') {
    const scrapDefinition = args.definitionsById && Object.hasOwn(args.definitionsById, definition.durability.scrapItemId)
      ? args.definitionsById[definition.durability.scrapItemId] : undefined;
    const scrap = validateItemDefinition(scrapDefinition, {
      definitionsById: args.definitionsById,
    });
    next = addTraits(next, container.containerId, {
      itemId: scrap.itemId, quality: null, durability: null, metadata: {},
    }, quantity, scrap, input.nextStackId);
  }
  return {
    state: next,
    event: { type: 'inventory.item_broken', payload: {
      containerId: container.containerId, stackId: stack.stackId, itemId: stack.itemId, quantity,
    } },
  };
}

export const inventoryInternals = Object.freeze({ validateState, reservedByStack, structuralEqual });
