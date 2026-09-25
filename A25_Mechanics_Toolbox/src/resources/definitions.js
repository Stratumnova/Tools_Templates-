import { copyImmutableData } from '../core/immutable-data.js';
import { isStableIdentifier } from '../core/identifiers.js';

export class InventoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    this.details = details;
  }
}

export function inventoryError(code, message, details = {}) {
  return new InventoryError(code, message, details);
}

function fail(message) {
  throw inventoryError('inventory.invalid_definition', message);
}

function stableId(value, name) {
  if (!isStableIdentifier(value)) {
    fail(`${name} must be a stable identifier`);
  }
}

function validateDefinition(def, options, visiting) {
  let value;
  try {
    value = copyImmutableData(def, 'definition');
  } catch (error) {
    throw inventoryError('inventory.invalid_definition', error.message);
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') fail('definition must be a plain object');
  stableId(value.itemId, 'itemId');
  if (typeof value.schemaVersion !== 'string' || value.schemaVersion.trim() === '') fail('schemaVersion must be nonblank');
  if (typeof value.label !== 'string' || value.label.trim() === '') fail('label must be nonblank');
  if (!Array.isArray(value.tags)) fail('tags must be an array');
  const tags = new Set();
  for (const tag of value.tags) {
    if (typeof tag !== 'string' || tag.trim() === '') fail('tags must be nonblank strings');
    if (tags.has(tag)) fail('tags must be unique');
    tags.add(tag);
  }
  if (!Number.isInteger(value.stackLimit) || value.stackLimit <= 0) fail('stackLimit must be a positive integer');
  if (!value.durability || Array.isArray(value.durability) || typeof value.durability !== 'object') {
    fail('durability must be an object');
  }
  if (value.durability.enabled === false) {
    if (Reflect.ownKeys(value.durability).length !== 1) fail('disabled durability cannot declare break behavior');
  } else if (value.durability.enabled === true) {
    if (!Number.isInteger(value.durability.max) || value.durability.max <= 0) fail('durability max must be positive');
    if (!['remove', 'scrap'].includes(value.durability.breakPolicy)) fail('breakPolicy must be remove or scrap');
    if (value.durability.breakPolicy === 'scrap') {
      stableId(value.durability.scrapItemId, 'scrapItemId');
      const scrap = options.definitionsById && Object.hasOwn(options.definitionsById, value.durability.scrapItemId)
        ? options.definitionsById[value.durability.scrapItemId] : undefined;
      if (!scrap || scrap.itemId !== value.durability.scrapItemId) fail('scrapItemId must reference a validated item');
      if (visiting.has(value.itemId)) fail('scrap references must not contain cycles');
      const nextVisiting = new Set(visiting);
      nextVisiting.add(value.itemId);
      const validatedScrap = validateDefinition(scrap, options, nextVisiting);
      if (validatedScrap.durability.enabled !== false) {
        fail('scrapItemId must reference a terminal non-durable item');
      }
    } else if (Object.hasOwn(value.durability, 'scrapItemId')) fail('remove policy cannot declare scrapItemId');
  } else fail('durability.enabled must be boolean');
  return mutableClone(value);
}

export function validateItemDefinition(def, options = {}) {
  return validateDefinition(def, options, new Set());
}

export function mutableClone(value) {
  if (Array.isArray(value)) return value.map(mutableClone);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      Object.defineProperty(result, key, {
        value: mutableClone(value[key]), enumerable: true, writable: true, configurable: true,
      });
    }
    return result;
  }
  return value;
}

export function validatedClone(value, name) {
  return mutableClone(copyImmutableData(value, name));
}
