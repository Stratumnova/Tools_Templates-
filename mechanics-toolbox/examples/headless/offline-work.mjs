import {
  advanceOffline, claimTask, createTask, startTask,
} from '../../src/index.js';

let sequence = 0;
const context = {
  createEvent(type, payload) {
    sequence += 1;
    return { eventId: `example-${sequence}`, type, payload };
  },
};

const available = createTask({
  taskId: 'task-1', taskType: 'work.basic', priority: 0, payload: {},
  durationMs: 1000, createdAt: 0, reservationIds: [],
});
const claimed = claimTask(available, { actorId: 'worker-1', claimedAt: 0 }).task;
const active = startTask(claimed, { actorId: 'worker-1', startedAt: 0 }).task;
const result = advanceOffline({
  clock: { now: 0 }, tasksById: { [active.taskId]: active }, offlineClaimsById: {},
}, { from: 0, to: 2000, maxDurationMs: 2000, claimId: 'offline-1' }, context);

console.log(`claim=${result.claimId} completed=${result.summary.completedTaskIds.length} status=${result.summary.status}`);
