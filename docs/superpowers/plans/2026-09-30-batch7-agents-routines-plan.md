# Batch 7 Agents and Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic agent decision layer that selects and dispatches accepted Batch 1–6 commands without replacing their authoritative state or mutation contracts.

**Architecture:** New focused modules under `src/agents/` validate agent-owned state, calculate deterministic choices, and emit resolved decision facts. Existing engine, permission, task, inventory, crafting, time, offline, and market modules remain authoritative; agents only propose commands through `engine.dispatch(command)`.

**Tech Stack:** Browser-native JavaScript ES modules, Node.js 22 test runner for development, no runtime dependencies, GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-09-30-batch7-agents-routines-design.md`

## Global Constraints

- Batch 7 branches from finalized Batch 6 main commit `76f8ea0e13714ae4e334a6b9b9c35d7ba5a4dca6`.
- `engine.dispatch(command)` remains the only mutation ingress.
- Capability policy remains authoritative for player and NPC actors.
- Agent decisions record resolved facts; reducers never rescore historical decisions.
- IDs, sequences, schedules, scores, and offline limits use safe deterministic integers.
- No runtime dependency, server, account, analytics, advertising, payment system, or build step is added.
- Wildlife, movement/UI models, persistence/rooms, and final artwork remain outside Batch 7.
- **Prior-batch approval gate:** before changing any Batch 1–6 file, interface, command, event, reducer, test expectation, documentation contract, fixture, or behavior, stop and obtain Matthew's explicit approval naming the exact target, reason, risk, and smallest proposed change.

## Review Focus

- Accessors, cycles, sparse arrays, symbols, inherited keys, and non-finite numbers reject without executing hostile code; Tasks 1–6 include hostile-data tests.
- Safe-integer boundaries reject before IDs, events, or partial state are published; Tasks 1, 4, 5, and 7 test overflow.
- Equal scores, times, salience, and priorities resolve through documented stable-ID ordering; Tasks 2–5 test ties.
- Replay after needs, schedules, memories, permissions, or market prices change applies recorded facts without recalculation; Tasks 5–8 test altered-input replay.
- Duplicate offline claims and repeated terminal events create no new memories, goals, reservations, crafts, stock, or trades; Tasks 6–8 test idempotency.

---

### Task 1: Deterministic needs

**Files:**
- Create: `mechanics-toolbox/src/agents/needs.js`
- Create: `mechanics-toolbox/tests/unit/agent-needs.test.js`

**Interfaces:**
- Consumes: `copyImmutableData(value, name)` from `src/core/immutable-data.js`; it is imported without modifying the Batch 1 file.
- Produces: `validateNeedDefinition(definition)`, `createNeedState(definition, sequence)`, and `advanceNeed(needState, definition, targetSequence)`.

- [ ] **Step 1: Write failing need-contract tests**

Add tests named `validates_and_isolates_need_definitions`, `advances_decay_by_complete_intervals`, `clamps_at_minimum`, `rejects_backward_time_and_overflow`, and `rejects_hostile_need_data_without_getter_execution`. Assert exact state fields: `needId`, `value`, `lastSequence`, and `appliedIntervals`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd mechanics-toolbox && node --test tests/unit/agent-needs.test.js`

Expected: FAIL because `src/agents/needs.js` does not exist.

- [ ] **Step 3: Implement the three need functions**

`validateNeedDefinition` accepts stable `needId`, safe integer `minimum`, `maximum`, `initial`, positive `interval`, nonnegative `decayPerInterval`, positive `weight`, and a dense urgency-points array. `advanceNeed` applies only complete intervals and never reads ambient time.

- [ ] **Step 4: Run focused and complete tests**

Run: `cd mechanics-toolbox && node --test tests/unit/agent-needs.test.js && npm test`

Expected: focused tests pass and the accepted 132 Batch 1–6 tests remain green.

- [ ] **Step 5: Commit**

`git commit -m "Add deterministic agent needs"`

### Task 2: Skills, roles, and bounded memory

**Files:**
- Create: `mechanics-toolbox/src/agents/skills.js`
- Create: `mechanics-toolbox/src/agents/memory.js`
- Create: `mechanics-toolbox/tests/unit/agent-skills-memory.test.js`

**Interfaces:**
- Consumes: immutable-data copying from Batch 1 without modifying it.
- Produces: `validateSkillProfile(profile)`, `validateRoleSet(roles)`, `createAgentMemory(capacity)`, and `rememberObservation(memory, observation)`.

- [ ] **Step 1: Write failing skill and memory tests**

Test safe integer skills, dense unique role IDs, caller isolation, duplicate memory IDs, capacity 1–1000, and deterministic eviction by salience ascending, sequence ascending, memory ID ascending. Include accessor, cycle, sparse-array, symbol, inherited-key, and unsafe-integer attacks.

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd mechanics-toolbox && node --test tests/unit/agent-skills-memory.test.js`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement validation and bounded memory**

An observation has `memoryId`, `kind`, `subjectId`, `sequence`, `salience`, and immutable plain-object `data`. The returned memory is a new value and never mutates caller input.

- [ ] **Step 4: Run focused and complete tests**

Run: `cd mechanics-toolbox && node --test tests/unit/agent-skills-memory.test.js && npm test`

- [ ] **Step 5: Commit**

`git commit -m "Add agent skills roles and bounded memory"`

### Task 3: Recurring routines

**Files:**
- Create: `mechanics-toolbox/src/agents/routines.js`
- Create: `mechanics-toolbox/tests/unit/agent-routines.test.js`

**Interfaces:**
- Consumes: explicit simulation sequence supplied by existing clock callers.
- Produces: `validateRoutineDefinition(definition)` and `eligibleRoutineCandidates(definitions, sequence, context)`.

- [ ] **Step 1: Write failing routine boundary tests**

Test exact start/end boundaries, wrap-free recurring windows, required roles, disabled routines, deterministic definition ordering, huge safe sequences, and malformed or hostile data.

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd mechanics-toolbox && node --test tests/unit/agent-routines.test.js`

- [ ] **Step 3: Implement routine validation and candidate creation**

A routine defines `routineId`, positive `period`, `startOffset`, `duration`, `priority`, required role IDs, and a plain-object existing-command template. This module never advances the clock or dispatches the command.

- [ ] **Step 4: Run focused and complete tests**

Run: `cd mechanics-toolbox && node --test tests/unit/agent-routines.test.js && npm test`

- [ ] **Step 5: Commit**

`git commit -m "Add deterministic agent routines"`

### Task 4: Integer utility scoring

**Files:**
- Create: `mechanics-toolbox/src/agents/utility.js`
- Create: `mechanics-toolbox/tests/unit/agent-utility.test.js`

**Interfaces:**
- Consumes: candidates with `candidateId`, `priority`, and safe integer component inputs.
- Produces: `scoreCandidate(candidate, weights)` and `rankCandidates(candidates, weights)`.

- [ ] **Step 1: Write failing score and tie-order tests**

Assert exact component breakdown and total for need pressure, routine priority, skill fit, memory evidence, task urgency, switching cost, and modifiers. Test overflow rejection and tie order: total descending, priority descending, candidate ID ascending.

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd mechanics-toolbox && node --test tests/unit/agent-utility.test.js`

- [ ] **Step 3: Implement safe integer scoring**

Every multiplication and sum checks `Number.isSafeInteger`. The result includes the immutable component breakdown; no random or current-time read is allowed.

- [ ] **Step 4: Run focused and complete tests**

Run: `cd mechanics-toolbox && node --test tests/unit/agent-utility.test.js && npm test`

- [ ] **Step 5: Commit**

`git commit -m "Add deterministic agent utility scoring"`

### Task 5: Agent state and decision selection

**Files:**
- Create: `mechanics-toolbox/src/agents/agents.js`
- Create: `mechanics-toolbox/src/agents/selection.js`
- Create: `mechanics-toolbox/tests/unit/agent-selection.test.js`

**Interfaces:**
- Consumes: validated needs, skills, roles, memory, routine candidates, and ranked utility records from Tasks 1–4.
- Produces: `createAgentState(input)`, `validateAgentState(state)`, `selectAgentDecision(input)`, and `applyAgentDecisionFact(state, fact)`.

- [ ] **Step 1: Write failing lifecycle and replay tests**

Cover register, idle, start, retain, interrupt, suspend, resume, complete, duplicate decision ID, stale sequence, terminal goal, interrupt margin, hard interruption, and changed-input replay. Assert a decision fact contains every ranked candidate and resolved score breakdown.

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd mechanics-toolbox && node --test tests/unit/agent-selection.test.js`

- [ ] **Step 3: Implement aggregate validation and resolved selection**

`selectAgentDecision` returns `decisionId`, `agentId`, `sequence`, `action`, `winner`, `rankedCandidates`, `previousGoal`, and `reason`. `applyAgentDecisionFact` validates those facts but never invokes Tasks 3–4 scoring.

- [ ] **Step 4: Run focused and complete tests**

Run: `cd mechanics-toolbox && node --test tests/unit/agent-selection.test.js && npm test`

- [ ] **Step 5: Commit**

`git commit -m "Add agent decision lifecycle and replay"`

### Task 6: Engine handlers and shared command vocabulary

**Files:**
- Create: `mechanics-toolbox/src/agents/handlers.js`
- Create: `mechanics-toolbox/tests/integration/agent-engine.test.js`

**Interfaces:**
- Consumes: existing `accept`, `reject`, registry, permission policy, event store, engine, and ID/clock injection without modifying them.
- Produces: `createAgentHandlers(options)` for `agent.register`, `agent.need_advance`, `agent.memory_observe`, `agent.decide`, `agent.goal_interrupt`, `agent.goal_resume`, and `agent.goal_complete`.

- [ ] **Step 1: Write failing real-engine tests**

Register new handlers in the existing Batch 2 registry. Test command-bound events, actor ownership, payload actor override resistance, capability denial, stale revision, forged events, duplicate IDs, event-store rollback, and fact-only replay.

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd mechanics-toolbox && node --test tests/integration/agent-engine.test.js`

- [ ] **Step 3: Implement handlers using existing engine contracts**

Handler decisions may update only agent-owned state through emitted facts. The selected gameplay command remains a proposal for a separate `engine.dispatch` call.

- [ ] **Step 4: Run focused and complete tests**

Run: `cd mechanics-toolbox && node --test tests/integration/agent-engine.test.js && npm test`

- [ ] **Step 5: Commit**

`git commit -m "Integrate agents with the command engine"`

### Task 7: Bounded offline agent decisions

**Files:**
- Create: `mechanics-toolbox/src/agents/offline.js`
- Create: `mechanics-toolbox/tests/integration/agent-offline.test.js`

**Interfaces:**
- Consumes: explicit intervals already validated and claimed by Batch 4 offline work; no Batch 4 file changes.
- Produces: `advanceAgentsOffline(state, input)`, where input supplies `intervalId`, `fromSequence`, `toSequence`, `maxDecisions`, candidate facts, and injected decision IDs.

- [ ] **Step 1: Write failing offline idempotency tests**

Test bounded decision count, chronological order, exact interval boundaries, duplicate claim replay, zero-duration intervals, stale intervals, unsafe spans, and no duplicate memories/goals after retry.

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd mechanics-toolbox && node --test tests/integration/agent-offline.test.js`

- [ ] **Step 3: Implement fact-producing offline advancement**

The function returns resolved agent facts plus a summary. It does not claim Batch 4 intervals, advance the clock, or dispatch gameplay commands.

- [ ] **Step 4: Run focused and complete tests**

Run: `cd mechanics-toolbox && node --test tests/integration/agent-offline.test.js && npm test`

- [ ] **Step 5: Commit**

`git commit -m "Add bounded offline agent decisions"`

### Task 8: Stall-worker candidate adapter and cross-system scenario

**Files:**
- Create: `mechanics-toolbox/src/agents/stall-worker.js`
- Create: `mechanics-toolbox/data/routines/stall-worker.json`
- Create: `mechanics-toolbox/tests/integration/stall-worker-chain.test.js`
- Create: `mechanics-toolbox/examples/headless/stall-worker-day.mjs`
- Conditional prior-batch target requiring approval: `mechanics-toolbox/src/market/market.js`
- Conditional prior-batch tests requiring approval: `mechanics-toolbox/tests/unit/market.test.js` and `market-adversarial.test.js`

**Interfaces:**
- Consumes: existing task, inventory, crafting, and market public commands plus Tasks 1–7.
- Produces: `buildStallWorkerCandidates(context)` and a complete headless example.

- [ ] **Step 1: Prove whether accepted Batch 6 exposes owned stall restocking**

Inspect public market handlers and tests. Expected finding from the approved spec review: fulfillment exists, but post-creation owned restock does not.

- [ ] **Step 2: Stop at the prior-batch approval gate if restock is absent**

Ask Matthew before editing Batch 6. Name exact target: `src/market/market.js`. Proposed smallest compatibility extension: `market.stall_restock`, owned by the stall owner, moving exact recorded quantity from the owner's actor inventory into the owned stall with conservation, duplicate fact protection, safe arithmetic, and fact-only replay. State compatibility risk: new optional command/event only; existing state shape remains valid.

- [ ] **Step 3: Write failing stall-worker chain tests**

Test low-stock observation, deterministic craft candidate selection, existing task and production lifecycle use, approved owned restock, Batch 6 fulfillment, exact currency/item conservation, capability denial, interrupted production, closed orders, changed-price replay, and retry idempotency.

- [ ] **Step 4: Implement only the approved adapter and new Batch 7 files**

`buildStallWorkerCandidates` creates existing-command proposals; it never edits Batch 1–6 state maps. Any approved restock extension is developed with its own Batch 6 regression tests first.

- [ ] **Step 5: Run the chain, complete suite, and all examples**

Run: `cd mechanics-toolbox && node --test tests/integration/stall-worker-chain.test.js && npm test && for file in examples/headless/*.mjs; do node "$file"; done`

- [ ] **Step 6: Commit**

`git commit -m "Add deterministic stall worker integration"`

### Task 9: Public exports, manifest, documentation, and CI

**Files requiring prior-batch approval before modification:**
- Modify: `mechanics-toolbox/src/index.js`
- Modify: `mechanics-toolbox/manifest.json`
- Modify: `mechanics-toolbox/package.json`
- Modify: `mechanics-toolbox/README.md`
- Modify: `.github/workflows/mechanics-toolbox.yml`
- Create: `mechanics-toolbox/docs/categories/agents-and-routines.md`

**Interfaces:**
- Consumes: reviewed public functions from Tasks 1–8.
- Produces: toolbox version `0.7.0`, public `agents` export family, documented contracts, and CI execution of every headless example.

- [ ] **Step 1: Stop and request prior-batch integration-file approval**

Ask Matthew to approve the exact five existing-file modifications. Explain that these files are the accepted public export/version/documentation/CI surfaces and that new modules remain inaccessible or untracked without the minimal additions. Compatibility risk is additive exports and version metadata; existing exports and scripts remain unchanged.

- [ ] **Step 2: Write export and manifest tests**

Add `tests/unit/agent-public-api.test.js` asserting every approved public name, version `0.7.0`, and `agents` in manifest exports.

- [ ] **Step 3: Apply the approved minimal additions**

Do not rename or remove any Batch 1–6 export, command, script, documentation section, or CI step.

- [ ] **Step 4: Run complete verification**

Run: `cd mechanics-toolbox && npm test && for file in examples/headless/*.mjs; do node "$file"; done`

- [ ] **Step 5: Commit the green durable checkpoint**

`git commit -m "Complete Mechanics Toolbox Batch 7 agents and routines"`

### Task 10: Review, repair, package, and PR

**Files:**
- Create after review: `checkpoints/mechanics-toolbox/batch-07.zip`
- Create after review: `checkpoints/mechanics-toolbox/A25_Mechanics_Toolbox_batch07.zip`
- Create: `mechanics-toolbox/checkpoint-batch07.json`

**Interfaces:**
- Consumes: the complete green Batch 7 tree.
- Produces: independently reviewed checkpoint and PR to `main`.

- [ ] **Step 1: Push the first complete green checkpoint**

Record exact branch SHA and successful CI run before review.

- [ ] **Step 2: Run independent adversarial review**

Review non-drift, ownership, scoring overflow, tie ordering, hostile data, interruption matrix, replay, offline idempotency, command capability, and cross-system conservation. Commit Critical/Important fixes separately and rerun a scoped review.

- [ ] **Step 3: Run final verification on the reviewed SHA**

Run complete tests and every headless example. Confirm GitHub CI success on the same SHA.

- [ ] **Step 4: Build and verify the ZIP**

Archive the `mechanics-toolbox/` tree, verify file count, paths, CRC integrity, source commit/tree provenance, and package name.

- [ ] **Step 5: Commit checkpoint aliases and provenance**

Both ZIP paths must reference identical bytes. Add `checkpoint-batch07.json` with source SHA, tree, archive blob, size, file count, test totals, example count, and `reviewStatus: accepted`.

- [ ] **Step 6: Open and merge the PR**

Open `build/mechanics-toolbox-batch-07` to `main`. Merge only when the PR head SHA, reviewed SHA, packaged source SHA, and successful CI SHA match.
