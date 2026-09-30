import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateQuality,
  matchRecipeInputs,
  validateRecipe,
} from '../../src/index.js';
import { definitionsById, matchingState, recipe } from '../helpers/crafting-fixtures.js';

test('validateRecipe returns an isolated immutable recipe', () => {
  const source = recipe();
  const result = validateRecipe(source);
  source.inputs[0].quantity = 99;
  source.stationTags.push('changed');

  assert.equal(result.inputs[0].quantity, 2);
  assert.deepEqual(result.stationTags, ['outdoors', 'workbench']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.inputs), true);
  assert.equal(Object.isFrozen(source), false);
});

test('validateRecipe rejects malformed records, duplicate values, and unsafe numbers', () => {
  const cases = [
    { recipeId: 'bad id' },
    { inputs: [{ itemId: 'material.wood', quantity: 1 }, { itemId: 'material.wood', quantity: 2 }] },
    { outputs: [{ itemId: 'item.trap', quantity: 1 }, { itemId: 'item.trap', quantity: 1 }] },
    { byproducts: [{ itemId: 'material.scrap', quantity: 1 }, { itemId: 'material.scrap', quantity: 1 }] },
    { substitutionGroups: [{ groupId: 'binding', quantity: 1, options: ['material.rope', 'material.rope'] }] },
    { substitutionGroups: [{ groupId: 'binding', quantity: 1, options: [] }] },
    { tools: [{ itemId: 'tool.knife', minDurability: 1 }, { itemId: 'tool.knife', minDurability: 2 }] },
    { stationTags: ['workbench', 'workbench'] },
    { durationMs: Number.MAX_VALUE },
    { difficulty: -1 },
    { difficulty: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const changed of cases) {
    assert.throws(() => validateRecipe({ ...recipe(), ...changed }), { code: 'craft.invalid_recipe' });
  }
  assert.throws(() => validateRecipe(recipe(), {
    existingRecipesById: { 'craft.trap': recipe() },
  }), { code: 'craft.duplicate_recipe' });
});

test('validateRecipe rejects hostile JSON values, inherited maps, sparse arrays, and does not touch callers', () => {
  const cycle = recipe(); cycle.self = cycle;
  const accessor = recipe(); Object.defineProperty(accessor, 'extra', { enumerable: true, get: () => 1 });
  const sparse = recipe(); sparse.inputs = [, sparse.inputs[0]];
  for (const value of [cycle, accessor, sparse, { ...recipe(), extra: undefined }]) {
    assert.throws(() => validateRecipe(value), { code: 'craft.invalid_recipe' });
    assert.equal(Object.isFrozen(value), false);
  }
  const inherited = Object.create({ hidden: recipe() });
  inherited.other = recipe();
  assert.throws(() => validateRecipe(recipe(), { existingRecipesById: inherited }), {
    code: 'craft.invalid_recipe',
  });
});

test('matchRecipeInputs uses input, group-option, and stack order deterministically', () => {
  const state = matchingState();
  const result = matchRecipeInputs(state, recipe(), {
    sourceContainerId: 'bag', stationId: 'bench',
  }, { definitionsById });

  assert.deepEqual(result.ingredients, [
    {
      requirementType: 'input', requirementId: 'material.wood', itemId: 'material.wood', quantity: 2,
      allocations: [
        { stackId: 'wood-a', quantity: 1, quality: 80, durability: null, metadata: {} },
        { stackId: 'wood-b', quantity: 1, quality: 60, durability: null, metadata: {} },
      ],
    },
    {
      requirementType: 'substitution', requirementId: 'binding', itemId: 'material.rope', quantity: 2,
      allocations: [
        { stackId: 'rope-a', quantity: 1, quality: 70, durability: null, metadata: {} },
        { stackId: 'rope-b', quantity: 1, quality: 50, durability: null, metadata: {} },
      ],
    },
  ]);
  assert.deepEqual(result.tools, [{
    itemId: 'tool.knife', stackId: 'knife-a', durability: 8, condition: 80,
  }]);
  assert.equal(result.stationId, 'bench');
  assert.deepEqual(state, matchingState());
});

test('substitution matching exhausts each declared option before trying the next', () => {
  const state = matchingState();
  state.containersById.bag.stacks.find(stack => stack.stackId === 'rope-b').quantity = 0;
  state.containersById.bag.stacks = state.containersById.bag.stacks.filter(stack => stack.quantity > 0);
  const result = matchRecipeInputs(state, recipe(), {
    sourceContainerId: 'bag', stationId: 'bench',
  }, { definitionsById });
  assert.deepEqual(result.ingredients.slice(1).map(match => [match.itemId, match.quantity]), [
    ['material.rope', 1], ['material.vine', 1],
  ]);
});

test('matching rejects shortages, unsuitable tools, and missing station tags without mutation', () => {
  for (const mutate of [
    state => { state.containersById.bag.stacks = state.containersById.bag.stacks.filter(stack => stack.itemId !== 'material.wood'); },
    state => { state.containersById.bag.stacks.find(stack => stack.stackId === 'knife-a').durability = 1; },
    state => { state.stationsById.bench.tags = ['workbench']; },
  ]) {
    const state = matchingState(); mutate(state); const before = structuredClone(state);
    assert.throws(() => matchRecipeInputs(state, recipe(), {
      sourceContainerId: 'bag', stationId: 'bench',
    }, { definitionsById }), error => error?.code?.startsWith('craft.'));
    assert.deepEqual(state, before);
  }
});

test('calculateQuality is deterministic, clamped to 0..100, and requires an explicit bounded roll', () => {
  assert.equal(calculateQuality({ skill: 50, difficulty: 50, toolCondition: 50, inputQuality: 50, roll: 0.5 }), 50);
  assert.equal(calculateQuality({ skill: 0, difficulty: 100, toolCondition: 0, inputQuality: 0, roll: 0 }), 0);
  assert.equal(calculateQuality({ skill: 100, difficulty: 0, toolCondition: 100, inputQuality: 100, roll: 1 }), 100);
  assert.equal(calculateQuality({ skill: 50, difficulty: 50, toolCondition: 50, inputQuality: 50, roll: 0 }), 40);
  assert.equal(calculateQuality({ skill: 50, difficulty: 50, toolCondition: 50, inputQuality: 50, roll: 1 }), 60);
  for (const input of [
    { skill: 50, difficulty: 50, toolCondition: 50, inputQuality: 50 },
    { skill: 50, difficulty: 50, toolCondition: 50, inputQuality: 50, roll: -0.01 },
    { skill: 50, difficulty: 50, toolCondition: 50, inputQuality: 50, roll: 1.01 },
  ]) assert.throws(() => calculateQuality(input), { code: 'craft.invalid_quality' });
});
