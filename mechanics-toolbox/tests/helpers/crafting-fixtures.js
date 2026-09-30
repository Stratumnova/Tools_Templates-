export const recipe = () => ({
  recipeId: 'craft.trap',
  schemaVersion: '1.0.0',
  inputs: [{ itemId: 'material.wood', quantity: 2 }],
  substitutionGroups: [{
    groupId: 'binding', quantity: 2,
    options: ['material.rope', 'material.vine'],
  }],
  tools: [{ itemId: 'tool.knife', minDurability: 2 }],
  stationTags: ['outdoors', 'workbench'],
  durationMs: 10,
  outputs: [{ itemId: 'item.trap', quantity: 1 }],
  byproducts: [{ itemId: 'material.scrap', quantity: 1 }],
  skillId: 'skill.crafting',
  difficulty: 40,
});

export const definitionsById = {
  'material.wood': { itemId: 'material.wood', schemaVersion: '1.0.0', label: 'Wood', tags: ['material'], stackLimit: 20, durability: { enabled: false } },
  'material.rope': { itemId: 'material.rope', schemaVersion: '1.0.0', label: 'Rope', tags: ['material'], stackLimit: 20, durability: { enabled: false } },
  'material.vine': { itemId: 'material.vine', schemaVersion: '1.0.0', label: 'Vine', tags: ['material'], stackLimit: 20, durability: { enabled: false } },
  'tool.knife': { itemId: 'tool.knife', schemaVersion: '1.0.0', label: 'Knife', tags: ['tool'], stackLimit: 1, durability: { enabled: true, max: 10, breakPolicy: 'remove' } },
  'item.trap': { itemId: 'item.trap', schemaVersion: '1.0.0', label: 'Trap', tags: ['crafted'], stackLimit: 10, durability: { enabled: false } },
  'material.scrap': { itemId: 'material.scrap', schemaVersion: '1.0.0', label: 'Scrap', tags: ['material'], stackLimit: 20, durability: { enabled: false } },
};

export function matchingState() {
  return {
    containersById: {
      bag: { containerId: 'bag', capacity: 30, stacks: [
        { stackId: 'wood-a', itemId: 'material.wood', quantity: 1, quality: 80, durability: null, metadata: {} },
        { stackId: 'wood-b', itemId: 'material.wood', quantity: 2, quality: 60, durability: null, metadata: {} },
        { stackId: 'vine-a', itemId: 'material.vine', quantity: 2, quality: 40, durability: null, metadata: {} },
        { stackId: 'rope-a', itemId: 'material.rope', quantity: 1, quality: 70, durability: null, metadata: {} },
        { stackId: 'rope-b', itemId: 'material.rope', quantity: 1, quality: 50, durability: null, metadata: {} },
        { stackId: 'knife-a', itemId: 'tool.knife', quantity: 1, quality: null, durability: 8, metadata: {} },
      ] },
      output: { containerId: 'output', capacity: 20, stacks: [] },
    },
    reservationsById: {},
    taskReservationsById: {},
    craftJobsById: {},
    stationsById: {
      bench: { stationId: 'bench', tags: ['workbench', 'outdoors', 'covered'] },
    },
  };
}
