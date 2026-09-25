import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelTask, claimTask, completeTask, createTask, failTask, interruptTask,
  releaseTaskResources, reserveTaskResources, startTask,
} from '../../src/index.js';

const input = () => ({
  taskId: 'task-1', taskType: 'work.basic', priority: 2, payload: { amount: 1 },
  durationMs: 10, createdAt: 5, reservationIds: [],
});

test('task lifecycle records deterministic facts, ownership, attempts, and caller isolation', () => {
  const source = input();
  const available = createTask(source);
  source.payload.amount = 99;
  assert.equal(available.status, 'AVAILABLE');
  assert.equal(available.payload.amount, 1);
  assert.equal(available.attemptCount, 0);

  const claimed = claimTask(available, { actorId: 'worker-1', claimedAt: 6 });
  assert.equal(claimed.task.status, 'CLAIMED');
  assert.equal(claimed.task.ownerId, 'worker-1');
  assert.equal(claimed.task.attemptCount, 1);
  assert.equal(claimed.event.type, 'task.claimed');
  assert.deepEqual(claimed.event.payload.task, claimed.task);

  const active = startTask(claimed.task, { actorId: 'worker-1', startedAt: 8 });
  assert.equal(active.task.endsAt, 18);
  assert.equal(active.event.type, 'task.started');
  const interrupted = interruptTask(active.task, { actorId: 'worker-1', interruptedAt: 12 });
  const reclaimed = claimTask(interrupted.task, { actorId: 'worker-1', claimedAt: 13 });
  assert.equal(reclaimed.task.attemptCount, 2);
  assert.equal(reclaimed.task.ownerId, 'worker-1');
  const restarted = startTask(reclaimed.task, { actorId: 'worker-1', startedAt: 14 });
  const completed = completeTask(restarted.task, { actorId: 'worker-1', completedAt: 24 });
  assert.equal(completed.task.status, 'COMPLETED');
  assert.equal(completed.task.completedAt, 24);
  assert.equal(available.status, 'AVAILABLE');
});

test('every legal failure and cancellation path works while illegal, foreign, and terminal transitions reject', () => {
  const available = createTask(input());
  const claimed = claimTask(available, { actorId: 'owner', claimedAt: 6 }).task;
  const active = startTask(claimed, { actorId: 'owner', startedAt: 7 }).task;
  const interrupted = interruptTask(active, { actorId: 'owner', interruptedAt: 8 }).task;
  for (const task of [claimed, active, interrupted]) {
    assert.equal(failTask(task, { actorId: task.ownerId, failedAt: 9, reason: 'blocked' }).task.status, 'FAILED');
  }
  for (const task of [available, claimed, interrupted]) {
    assert.equal(cancelTask(task, { actorId: task.ownerId ?? 'owner', cancelledAt: 9, reason: 'stopped' }).task.status, 'CANCELLED');
  }
  assert.throws(() => startTask(available, { actorId: 'owner', startedAt: 7 }));
  assert.throws(() => completeTask(active, { actorId: 'other', completedAt: 9 }));
  assert.throws(() => claimTask(claimed, { actorId: 'owner', claimedAt: 9 }));
  const terminal = completeTask(active, { actorId: 'owner', completedAt: 17 }).task;
  assert.throws(() => failTask(terminal, { actorId: 'owner', failedAt: 18, reason: 'late' }));
  assert.throws(() => startTask({ ...claimed, durationMs: Number.MAX_SAFE_INTEGER }, { actorId: 'owner', startedAt: 6 }), RangeError);
});

function taskByStatus() {
  const available = createTask(input());
  const claimed = claimTask(available, { actorId: 'owner', claimedAt: 5 }).task;
  const active = startTask(claimed, { actorId: 'owner', startedAt: 5 }).task;
  const interrupted = interruptTask(active, { actorId: 'owner', interruptedAt: 6 }).task;
  return {
    AVAILABLE: available,
    CLAIMED: claimed,
    ACTIVE: active,
    INTERRUPTED: interrupted,
    COMPLETED: completeTask(active, { actorId: 'owner', completedAt: 15 }).task,
    FAILED: failTask(claimed, { actorId: 'owner', failedAt: 5, reason: 'blocked' }).task,
    CANCELLED: cancelTask(available, { actorId: 'owner', cancelledAt: 5, reason: 'stopped' }).task,
  };
}

test('task transition matrix permits every legal source and rejects every illegal source', () => {
  const cases = [
    ['claim', claimTask, ['AVAILABLE', 'INTERRUPTED'], { actorId: 'owner', claimedAt: 6 }, 'CLAIMED'],
    ['start', startTask, ['CLAIMED'], { actorId: 'owner', startedAt: 6 }, 'ACTIVE'],
    ['interrupt', interruptTask, ['ACTIVE'], { actorId: 'owner', interruptedAt: 6 }, 'INTERRUPTED'],
    ['complete', completeTask, ['ACTIVE'], { actorId: 'owner', completedAt: 15 }, 'COMPLETED'],
    ['fail', failTask, ['CLAIMED', 'ACTIVE', 'INTERRUPTED'], { actorId: 'owner', failedAt: 6, reason: 'blocked' }, 'FAILED'],
    ['cancel', cancelTask, ['AVAILABLE', 'CLAIMED', 'INTERRUPTED'], { actorId: 'owner', cancelledAt: 6, reason: 'stopped' }, 'CANCELLED'],
  ];
  for (const [name, operation, legalSources, transitionInput, target] of cases) {
    for (const [source, task] of Object.entries(taskByStatus())) {
      if (legalSources.includes(source)) {
        assert.equal(operation(task, transitionInput).task.status, target, `${name} from ${source}`);
        if (task.ownerId !== null) {
          assert.throws(() => operation(task, { ...transitionInput, actorId: 'other' }),
            undefined, `${name} rejects foreign owner from ${source}`);
        }
      } else {
        assert.throws(() => operation(task, transitionInput), undefined, `${name} from ${source}`);
      }
    }
  }
});

test('transition timestamps are monotonic and equal boundaries are accepted', () => {
  const available = createTask({ ...input(), createdAt: 10 });
  assert.throws(() => claimTask(available, { actorId: 'owner', claimedAt: 9 }), RangeError);
  const claimed = claimTask(available, { actorId: 'owner', claimedAt: 10 }).task;
  assert.throws(() => startTask(claimed, { actorId: 'owner', startedAt: 9 }), RangeError);
  const active = startTask(claimed, { actorId: 'owner', startedAt: 10 }).task;
  assert.throws(() => interruptTask(active, { actorId: 'owner', interruptedAt: 9 }), RangeError);
  assert.equal(completeTask(active, { actorId: 'owner', completedAt: 20 }).task.completedAt, 20);
  assert.throws(() => completeTask(active, { actorId: 'owner', completedAt: 19 }), RangeError);
  assert.equal(failTask(active, { actorId: 'owner', failedAt: 10, reason: 'x' }).task.failedAt, 10);
  assert.throws(() => failTask(active, { actorId: 'owner', failedAt: 9, reason: 'x' }), RangeError);

  const interrupted = interruptTask(active, { actorId: 'owner', interruptedAt: 10 }).task;
  assert.throws(() => claimTask(interrupted, { actorId: 'owner', claimedAt: 9 }), RangeError);
  const reclaimed = claimTask(interrupted, { actorId: 'owner', claimedAt: 10 }).task;
  assert.equal(reclaimed.interruptedAt, 10);
  assert.equal(failTask(reclaimed, { actorId: 'owner', failedAt: 10, reason: 'x' }).task.status, 'FAILED');
  assert.equal(cancelTask(reclaimed, { actorId: 'owner', cancelledAt: 10, reason: 'x' }).task.status, 'CANCELLED');
  assert.equal(startTask(reclaimed, { actorId: 'owner', startedAt: 10 }).task.startedAt, 10);
  assert.equal(cancelTask(interrupted, { actorId: 'owner', cancelledAt: 10, reason: 'x' }).task.cancelledAt, 10);
});

test('every normalized task status enforces its ownership and timestamp facts', () => {
  const valid = taskByStatus();
  const malformed = [
    { ...valid.AVAILABLE, ownerId: 'owner' },
    { ...valid.CLAIMED, claimedAt: null },
    { ...valid.CLAIMED, attemptCount: 0 },
    { ...valid.ACTIVE, endsAt: 999 },
    { ...valid.INTERRUPTED, interruptedAt: 4 },
    { ...valid.COMPLETED, completedAt: null },
    { ...valid.FAILED, failedAt: null },
    { ...valid.FAILED, failureReason: null },
    { ...valid.CANCELLED, cancelledAt: null },
    { ...valid.CANCELLED, cancellationReason: null },
    { ...valid.CLAIMED, payload: [] },
  ];
  for (const task of malformed) {
    assert.throws(() => claimTask(task, { actorId: 'owner', claimedAt: 20 }));
  }
});

test('task construction validates identifiers, integer fields, JSON data, and timestamps', () => {
  for (const bad of [
    { taskId: 'bad id' }, { taskType: 'bad type' }, { priority: 1.5 }, { durationMs: -1 },
    { createdAt: -1 }, { payload: { value: undefined } }, { reservationIds: ['bad id'] },
    { reservationIds: ['r-1', 'r-1'] },
  ]) assert.throws(() => createTask({ ...input(), ...bad }));
});

test('resource reservation is atomic, unique, owner-only, and safe for inherited names', () => {
  const state = { reservationsById: {} };
  const reserved = reserveTaskResources(state, {
    taskId: 'task-1', createdAt: 4,
    resources: [
      { reservationId: 'r-1', resourceType: 'worker', resourceId: 'toString' },
      { reservationId: 'r-2', resourceType: 'station', resourceId: 'forge-1' },
    ],
  });
  assert.deepEqual(reserved.reservationsById['r-1'], {
    reservationId: 'r-1', taskId: 'task-1', resourceType: 'worker',
    resourceId: 'toString', resourceKey: 'worker:toString', createdAt: 4,
  });
  assert.deepEqual(state, { reservationsById: {} });
  assert.throws(() => reserveTaskResources(reserved, {
    taskId: 'task-2', createdAt: 5,
    resources: [
      { reservationId: 'r-3', resourceType: 'route', resourceId: 'road-1' },
      { reservationId: 'r-4', resourceType: 'worker', resourceId: 'toString' },
    ],
  }));
  assert.equal(Object.hasOwn(reserved.reservationsById, 'r-3'), false);
  assert.throws(() => releaseTaskResources(reserved, { taskId: 'task-2', reservationIds: ['r-1'] }));
  const released = releaseTaskResources(reserved, { taskId: 'task-1', reservationIds: ['r-1', 'r-2'] });
  assert.deepEqual(released.reservationsById, {});
  assert.throws(() => releaseTaskResources(released, { taskId: 'task-1', reservationIds: ['r-1'] }));
});

test('reservation rejects duplicate IDs, duplicate keys, unsupported types, and malformed state', () => {
  const base = { taskId: 'task-1', createdAt: 0 };
  for (const resources of [
    [{ reservationId: 'r', resourceType: 'worker', resourceId: 'a' }, { reservationId: 'r', resourceType: 'station', resourceId: 'b' }],
    [{ reservationId: 'a', resourceType: 'route', resourceId: 'x' }, { reservationId: 'b', resourceType: 'route', resourceId: 'x' }],
    [{ reservationId: 'a', resourceType: 'item', resourceId: 'x' }],
  ]) assert.throws(() => reserveTaskResources({ reservationsById: {} }, { ...base, resources }));
  assert.throws(() => reserveTaskResources({ reservationsById: { bad: {} } }, { ...base, resources: [] }));
});
