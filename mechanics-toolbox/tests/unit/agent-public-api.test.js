import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as toolbox from '../../src/index.js';

const publicAgentFunctions = [
  'validateNeedDefinition', 'createNeedState', 'advanceNeed',
  'validateSkillProfile', 'validateRoleSet',
  'createAgentMemory', 'rememberObservation',
  'validateRoutineDefinition', 'eligibleRoutineCandidates',
  'scoreCandidate', 'rankCandidates',
  'createAgentState', 'validateAgentState',
  'selectAgentDecision', 'applyAgentDecisionFact',
  'createAgentHandlers', 'advanceAgentsOffline', 'buildStallWorkerCandidates',
];

test('exports the complete Batch 7 agent API without removing prior exports', () => {
  for (const name of publicAgentFunctions) assert.equal(typeof toolbox[name], 'function', name);
  for (const priorName of ['createEngine', 'createInventoryHandlers', 'createTimeTaskHandlers',
    'createCraftingHandlers', 'createMarketHandlers']) {
    assert.equal(typeof toolbox[priorName], 'function', priorName);
  }
});

test('publishes version 0.7.0 and the agents manifest category', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url)));
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  assert.equal(manifest.version, '0.7.0');
  assert.equal(packageJson.version, '0.7.0');
  assert.ok(manifest.exports.includes('agents'));
});

test('CI indexes every current headless example', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/mechanics-toolbox.yml', import.meta.url), 'utf8');
  for (const example of [
    'dispatch.mjs', 'inventory-transfer.mjs', 'offline-work.mjs',
    'npc-crafts-trap.mjs', 'market-day.mjs', 'stall-worker-day.mjs',
  ]) assert.match(workflow, new RegExp(example.replace('.', '\\.')));
});
