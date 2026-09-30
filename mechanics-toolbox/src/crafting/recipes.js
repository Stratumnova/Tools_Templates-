import { isStableIdentifier } from '../core/identifiers.js';
import { copyImmutableData } from '../core/immutable-data.js';
import { inventoryInternals } from '../inventory/inventory.js';
import { validateItemDefinition } from '../resources/definitions.js';

export class CraftingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CraftingError';
    this.code = code;
    this.details = details;
  }
}

export function craftingError(code, message, details = {}) {
  return new CraftingError(code, message, details);
}

function failRecipe(message, details = {}) {
  throw craftingError('craft.invalid_recipe', message, details);
}

function immutableClone(value, name, code = 'craft.invalid_input') {
  try {
    return copyImmutableData(value, name);
  } catch (error) {
    throw craftingError(code, error.message);
  }
}

function requirePlainObject(value, name, code = 'craft.invalid_input') {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw craftingError(code, `${name} must be a plain object`);
  }
  return value;
}

function requireExactKeys(value, expected, name) {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) {
    failRecipe(`${name} contains unexpected or missing fields`);
  }
}

function requireId(value, name, fail = failRecipe) {
  if (!isStableIdentifier(value)) fail(`${name} must be a stable identifier`);
}

function requirePositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) failRecipe(`${name} must be a positive safe integer`);
}

function validateItemAmounts(values, name, { allowEmpty = false } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    failRecipe(`${name} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  const itemIds = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    requirePlainObject(value, `${name}[${index}]`, 'craft.invalid_recipe');
    requireExactKeys(value, ['itemId', 'quantity'], `${name}[${index}]`);
    requireId(value.itemId, `${name}[${index}].itemId`);
    requirePositiveSafeInteger(value.quantity, `${name}[${index}].quantity`);
    if (itemIds.has(value.itemId)) failRecipe(`${name} item IDs must be unique`, { itemId: value.itemId });
    itemIds.add(value.itemId);
  }
}

function validateGroups(groups) {
  if (!Array.isArray(groups)) failRecipe('substitutionGroups must be an array');
  const groupIds = new Set();
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    requirePlainObject(group, `substitutionGroups[${index}]`, 'craft.invalid_recipe');
    requireExactKeys(group, ['groupId', 'quantity', 'options'], `substitutionGroups[${index}]`);
    requireId(group.groupId, `substitutionGroups[${index}].groupId`);
    requirePositiveSafeInteger(group.quantity, `substitutionGroups[${index}].quantity`);
    if (groupIds.has(group.groupId)) failRecipe('substitution group IDs must be unique', { groupId: group.groupId });
    groupIds.add(group.groupId);
    if (!Array.isArray(group.options) || group.options.length === 0) {
      failRecipe('substitution group options must be a non-empty array', { groupId: group.groupId });
    }
    const options = new Set();
    for (const itemId of group.options) {
      requireId(itemId, 'substitution option');
      if (options.has(itemId)) failRecipe('substitution options must be unique', { groupId: group.groupId, itemId });
      options.add(itemId);
    }
  }
}

function validateTools(tools) {
  if (!Array.isArray(tools)) failRecipe('tools must be an array');
  const itemIds = new Set();
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    requirePlainObject(tool, `tools[${index}]`, 'craft.invalid_recipe');
    requireExactKeys(tool, ['itemId', 'minDurability'], `tools[${index}]`);
    requireId(tool.itemId, `tools[${index}].itemId`);
    if (!Number.isSafeInteger(tool.minDurability) || tool.minDurability < 0) {
      failRecipe('tool minDurability must be a non-negative safe integer');
    }
    if (itemIds.has(tool.itemId)) failRecipe('tool item IDs must be unique', { itemId: tool.itemId });
    itemIds.add(tool.itemId);
  }
}

function validateTags(tags) {
  if (!Array.isArray(tags)) failRecipe('stationTags must be an array');
  const unique = new Set();
  for (const tag of tags) {
    requireId(tag, 'station tag');
    if (unique.has(tag)) failRecipe('station tags must be unique', { tag });
    unique.add(tag);
  }
}

function validateExistingRecipes(options, recipeId) {
  if (options === undefined) return;
  const safeOptions = immutableClone(options, 'options', 'craft.invalid_recipe');
  requirePlainObject(safeOptions, 'options', 'craft.invalid_recipe');
  const keys = Object.keys(safeOptions);
  if (keys.some(key => key !== 'existingRecipesById')) failRecipe('options contains an unsupported field');
  if (!Object.hasOwn(safeOptions, 'existingRecipesById')) return;
  const map = safeOptions.existingRecipesById;
  requirePlainObject(map, 'existingRecipesById', 'craft.invalid_recipe');
  for (const id of Object.keys(map)) requireId(id, 'existing recipe ID');
  if (Object.hasOwn(map, recipeId)) {
    throw craftingError('craft.duplicate_recipe', 'recipe ID already exists', { recipeId });
  }
}

export function validateRecipe(recipe, options) {
  let value;
  try {
    value = copyImmutableData(recipe, 'recipe');
  } catch (error) {
    throw craftingError('craft.invalid_recipe', error.message);
  }
  requirePlainObject(value, 'recipe', 'craft.invalid_recipe');
  requireExactKeys(value, [
    'recipeId', 'schemaVersion', 'inputs', 'substitutionGroups', 'tools', 'stationTags',
    'durationMs', 'outputs', 'byproducts', 'skillId', 'difficulty',
  ], 'recipe');
  requireId(value.recipeId, 'recipeId');
  requireId(value.schemaVersion, 'schemaVersion');
  requireId(value.skillId, 'skillId');
  validateItemAmounts(value.inputs, 'inputs', { allowEmpty: true });
  validateGroups(value.substitutionGroups);
  if (value.inputs.length === 0 && value.substitutionGroups.length === 0) {
    failRecipe('recipe must declare at least one input or substitution group');
  }
  validateTools(value.tools);
  validateTags(value.stationTags);
  requirePositiveSafeInteger(value.durationMs, 'durationMs');
  validateItemAmounts(value.outputs, 'outputs');
  validateItemAmounts(value.byproducts, 'byproducts', { allowEmpty: true });
  const productIds = new Set(value.outputs.map(output => output.itemId));
  for (const byproduct of value.byproducts) {
    if (productIds.has(byproduct.itemId)) failRecipe('outputs and byproducts must not duplicate item IDs');
    productIds.add(byproduct.itemId);
  }
  if (!Number.isSafeInteger(value.difficulty) || value.difficulty < 0 || value.difficulty > 100) {
    failRecipe('difficulty must be a safe integer from 0 through 100');
  }
  validateExistingRecipes(options, value.recipeId);
  return value;
}

function requireDefinitions(value) {
  const definitions = immutableClone(value, 'definitionsById', 'craft.invalid_context');
  requirePlainObject(definitions, 'definitionsById', 'craft.invalid_context');
  return definitions;
}

function definitionFor(definitionsById, itemId) {
  const definition = Object.hasOwn(definitionsById, itemId) ? definitionsById[itemId] : undefined;
  try {
    const validated = validateItemDefinition(definition, { definitionsById });
    if (validated.itemId !== itemId) {
      throw new TypeError('definition map key must equal definition.itemId');
    }
    return validated;
  } catch (error) {
    throw craftingError('craft.invalid_definition', `item definition is invalid: ${itemId}`, { itemId });
  }
}

function stationFor(state, stationId) {
  const stations = state.stationsById;
  requirePlainObject(stations, 'state.stationsById');
  const station = Object.hasOwn(stations, stationId) ? stations[stationId] : undefined;
  if (!station || Array.isArray(station) || Object.getPrototypeOf(station) !== Object.prototype
      || station.stationId !== stationId || !Array.isArray(station.tags)) {
    throw craftingError('craft.station_not_found', 'station does not exist or is malformed', { stationId });
  }
  const tags = new Set();
  for (const tag of station.tags) {
    if (!isStableIdentifier(tag) || tags.has(tag)) {
      throw craftingError('craft.invalid_state', 'station tags must be unique stable identifiers', { stationId });
    }
    tags.add(tag);
  }
  return { station, tags };
}

function copyAllocation(stack, quantity) {
  return immutableClone({
    stackId: stack.stackId,
    quantity,
    quality: stack.quality,
    durability: stack.durability,
    metadata: stack.metadata,
  }, 'allocation');
}

function weightedQuality(ingredients) {
  let total = 0;
  let quantity = 0;
  for (const ingredient of ingredients) {
    for (const allocation of ingredient.allocations) {
      const quality = typeof allocation.quality === 'number'
        && Number.isFinite(allocation.quality) ? Math.min(100, Math.max(0, allocation.quality)) : 50;
      total += quality * allocation.quantity;
      quantity += allocation.quantity;
    }
  }
  return quantity === 0 ? 50 : total / quantity;
}

export function matchRecipeInputs(state, recipe, input, context = {}) {
  const normalizedRecipe = validateRecipe(recipe);
  const args = immutableClone(input, 'input');
  requirePlainObject(args, 'input');
  requireId(args.sourceContainerId, 'sourceContainerId', message => {
    throw craftingError('craft.invalid_input', message);
  });
  requireId(args.stationId, 'stationId', message => {
    throw craftingError('craft.invalid_input', message);
  });
  const definitionsById = requireDefinitions(context.definitionsById);
  let current;
  try {
    current = inventoryInternals.validateState(state);
  } catch (error) {
    throw craftingError('craft.invalid_state', error.message);
  }
  const container = Object.hasOwn(current.containersById, args.sourceContainerId)
    ? current.containersById[args.sourceContainerId] : undefined;
  if (!container) throw craftingError('craft.container_not_found', 'source container does not exist');
  const { tags } = stationFor(current, args.stationId);
  for (const tag of normalizedRecipe.stationTags) {
    if (!tags.has(tag)) throw craftingError('craft.station_mismatch', 'station is missing a required tag', { stationId: args.stationId, tag });
  }

  const unavailable = inventoryInternals.reservedByStack(current, args.sourceContainerId);
  const selected = new Map(unavailable);
  const ingredients = [];
  const take = (itemId, quantity, requirementType, requirementId) => {
    let remaining = quantity;
    const allocations = [];
    for (const stack of container.stacks) {
      if (stack.itemId !== itemId || remaining === 0) continue;
      const available = stack.quantity - (selected.get(stack.stackId) ?? 0);
      const amount = Math.min(remaining, available);
      if (amount > 0) {
        allocations.push(copyAllocation(stack, amount));
        selected.set(stack.stackId, (selected.get(stack.stackId) ?? 0) + amount);
        remaining -= amount;
      }
    }
    const matched = quantity - remaining;
    if (matched > 0) ingredients.push({
      requirementType, requirementId, itemId, quantity: matched, allocations,
    });
    return remaining;
  };

  for (const requirement of normalizedRecipe.inputs) {
    if (take(requirement.itemId, requirement.quantity, 'input', requirement.itemId) > 0) {
      throw craftingError('craft.insufficient_input', 'not enough input quantity is available', { itemId: requirement.itemId });
    }
  }
  for (const group of normalizedRecipe.substitutionGroups) {
    let remaining = group.quantity;
    for (const itemId of group.options) {
      if (remaining === 0) break;
      remaining = take(itemId, remaining, 'substitution', group.groupId);
    }
    if (remaining > 0) {
      throw craftingError('craft.insufficient_input', 'not enough substitution quantity is available', { groupId: group.groupId });
    }
  }

  const tools = [];
  for (const requirement of normalizedRecipe.tools) {
    const definition = definitionFor(definitionsById, requirement.itemId);
    const stack = container.stacks.find(candidate => (
      candidate.itemId === requirement.itemId
      && candidate.quantity - (unavailable.get(candidate.stackId) ?? 0) > 0
      && (candidate.durability ?? 0) >= requirement.minDurability
    ));
    if (!stack) throw craftingError('craft.tool_unavailable', 'required tool is missing or below minimum durability', { itemId: requirement.itemId });
    const condition = definition.durability.enabled
      ? Math.round((stack.durability / definition.durability.max) * 100) : 100;
    tools.push({ itemId: requirement.itemId, stackId: stack.stackId, durability: stack.durability, condition });
  }

  return immutableClone({
    sourceContainerId: args.sourceContainerId,
    stationId: args.stationId,
    ingredients,
    tools,
    inputQuality: weightedQuality(ingredients),
    toolCondition: tools.length === 0
      ? 100 : tools.reduce((sum, tool) => sum + tool.condition, 0) / tools.length,
  }, 'recipe match');
}

function requireQualityFactor(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw craftingError('craft.invalid_quality', `${name} must be a finite number from 0 through 100`);
  }
}

export function calculateQuality(input) {
  const args = immutableClone(input, 'input', 'craft.invalid_quality');
  requirePlainObject(args, 'input', 'craft.invalid_quality');
  for (const name of ['skill', 'difficulty', 'toolCondition', 'inputQuality']) {
    requireQualityFactor(args[name], name);
  }
  if (typeof args.roll !== 'number' || !Number.isFinite(args.roll) || args.roll < 0 || args.roll > 1) {
    throw craftingError('craft.invalid_quality', 'roll must be an explicitly supplied number from 0 through 1');
  }
  const raw = 50 + args.skill - args.difficulty
    + ((args.toolCondition - 50) * 0.2)
    + ((args.inputQuality - 50) * 0.2)
    + ((args.roll - 0.5) * 20);
  return Math.round(Math.min(100, Math.max(0, raw)));
}

export const recipeInternals = Object.freeze({
  definitionFor,
  immutableClone,
  requirePlainObject,
  stationFor,
});
