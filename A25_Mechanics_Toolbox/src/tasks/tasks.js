import { requireStableIdentifier } from '../core/identifiers.js';
import { copyImmutableData } from '../core/immutable-data.js';
import { clockInternals } from '../time/clock.js';

export const TASK_STATUSES = Object.freeze([
  'AVAILABLE', 'CLAIMED', 'ACTIVE', 'INTERRUPTED', 'COMPLETED', 'FAILED', 'CANCELLED',
]);

function plain(value, name) {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function validateTask(task) {
  plain(task, 'task');
  requireStableIdentifier(task.taskId, 'taskId');
  requireStableIdentifier(task.taskType, 'taskType');
  plain(task.payload, 'task.payload');
  if (!TASK_STATUSES.includes(task.status)) throw new TypeError('task status is invalid');
  if (!Number.isSafeInteger(task.priority)) throw new TypeError('priority must be a safe integer');
  if (!Number.isSafeInteger(task.durationMs) || task.durationMs < 0) throw new TypeError('durationMs must be non-negative');
  clockInternals.requireTimestamp(task.createdAt, 'createdAt');
  if (!Number.isSafeInteger(task.attemptCount) || task.attemptCount < 0) throw new TypeError('attemptCount must be non-negative');
  if (!Array.isArray(task.reservationIds)) throw new TypeError('reservationIds must be an array');
  const reservationIds = new Set();
  task.reservationIds.forEach((id, index) => {
    requireStableIdentifier(id, `reservationIds[${index}]`);
    if (reservationIds.has(id)) throw new TypeError('reservationIds must be unique');
    reservationIds.add(id);
  });
  const timestamp = (name, nullable = true) => {
    if (nullable && task[name] === null) return null;
    clockInternals.requireTimestamp(task[name], name);
    return task[name];
  };
  const requireNull = (...names) => {
    for (const name of names) if (task[name] !== null) throw new TypeError(`${name} must be null for ${task.status}`);
  };
  const requireOwner = () => requireStableIdentifier(task.ownerId, 'ownerId');
  const requireAttempts = () => {
    if (task.attemptCount < 1) throw new TypeError('attemptCount must be positive after claim');
  };
  const claimedAt = timestamp('claimedAt');
  const startedAt = timestamp('startedAt');
  const endsAt = timestamp('endsAt');
  const interruptedAt = timestamp('interruptedAt');
  const completedAt = timestamp('completedAt');
  const failedAt = timestamp('failedAt');
  const cancelledAt = timestamp('cancelledAt');
  const requireClaimHistory = (afterInterruption = false) => {
    requireOwner(); requireAttempts();
    if (claimedAt === null || claimedAt < task.createdAt) throw new TypeError('claimedAt must follow createdAt');
    if (afterInterruption && interruptedAt !== null && claimedAt < interruptedAt) throw new TypeError('reclaim must not precede interruption');
  };
  const requireStartHistory = (afterInterruption = false) => {
    requireClaimHistory(afterInterruption);
    if (startedAt === null || startedAt < claimedAt) throw new TypeError('startedAt must follow claimedAt');
    if (endsAt !== startedAt + task.durationMs || !Number.isSafeInteger(endsAt)) {
      throw new TypeError('endsAt must equal startedAt plus durationMs');
    }
  };
  if (task.status === 'AVAILABLE') {
    if (task.ownerId !== null || task.attemptCount !== 0) throw new TypeError('available task cannot have an owner or attempts');
    requireNull('claimedAt', 'startedAt', 'endsAt', 'interruptedAt', 'completedAt', 'failedAt', 'cancelledAt', 'failureReason', 'cancellationReason');
  } else if (task.status === 'CLAIMED') {
    requireClaimHistory(true);
    requireNull('startedAt', 'endsAt', 'completedAt', 'failedAt', 'cancelledAt', 'failureReason', 'cancellationReason');
  } else if (task.status === 'ACTIVE') {
    requireStartHistory(true);
    requireNull('completedAt', 'failedAt', 'cancelledAt', 'failureReason', 'cancellationReason');
  } else if (task.status === 'INTERRUPTED') {
    requireStartHistory();
    if (interruptedAt === null || interruptedAt < startedAt) throw new TypeError('interruptedAt must follow startedAt');
    requireNull('completedAt', 'failedAt', 'cancelledAt', 'failureReason', 'cancellationReason');
  } else if (task.status === 'COMPLETED') {
    requireStartHistory(true);
    if (completedAt === null || completedAt < endsAt) throw new TypeError('completedAt must not precede endsAt');
    requireNull('failedAt', 'cancelledAt', 'failureReason', 'cancellationReason');
  } else if (task.status === 'FAILED') {
    requireClaimHistory(startedAt === null && interruptedAt !== null);
    if ((startedAt === null) !== (endsAt === null)) throw new TypeError('failed task start facts must be complete');
    if (startedAt !== null) requireStartHistory();
    if (interruptedAt !== null && startedAt !== null
        && interruptedAt > claimedAt && interruptedAt < startedAt) throw new TypeError('interruptedAt is inconsistent with task history');
    const latest = Math.max(claimedAt, startedAt ?? 0, interruptedAt ?? 0);
    if (failedAt === null || failedAt < latest) throw new TypeError('failedAt must follow task history');
    if (typeof task.failureReason !== 'string' || task.failureReason.trim() === '') throw new TypeError('failureReason must be nonblank');
    requireNull('completedAt', 'cancelledAt', 'cancellationReason');
  } else if (task.status === 'CANCELLED') {
    const latest = Math.max(task.createdAt, claimedAt ?? 0, interruptedAt ?? 0);
    if (claimedAt === null) {
      if (task.ownerId !== null || task.attemptCount !== 0) throw new TypeError('unclaimed cancellation cannot have owner history');
      requireNull('startedAt', 'endsAt', 'interruptedAt');
    } else {
      requireClaimHistory(startedAt === null && interruptedAt !== null);
      if ((startedAt === null) !== (endsAt === null)) throw new TypeError('cancelled task start facts must be complete');
      if (startedAt !== null) requireStartHistory();
      if (interruptedAt !== null && startedAt !== null
          && interruptedAt > claimedAt && interruptedAt < startedAt) throw new TypeError('interruptedAt is inconsistent with task history');
    }
    if (cancelledAt === null || cancelledAt < latest) throw new TypeError('cancelledAt must follow task history');
    if (typeof task.cancellationReason !== 'string' || task.cancellationReason.trim() === '') throw new TypeError('cancellationReason must be nonblank');
    requireNull('completedAt', 'failedAt', 'failureReason');
  }
  copyImmutableData(task, 'task');
}

function frozenTask(value) {
  return copyImmutableData(value, 'task');
}

export function createTask(input) {
  plain(input, 'input');
  requireStableIdentifier(input.taskId, 'taskId');
  requireStableIdentifier(input.taskType, 'taskType');
  if (!Number.isSafeInteger(input.priority)) throw new TypeError('priority must be a safe integer');
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0) throw new TypeError('durationMs must be non-negative');
  clockInternals.requireTimestamp(input.createdAt, 'createdAt');
  plain(input.payload, 'payload');
  if (!Array.isArray(input.reservationIds)) throw new TypeError('reservationIds must be an array');
  const reservationIds = new Set();
  input.reservationIds.forEach((id, index) => {
    requireStableIdentifier(id, `reservationIds[${index}]`);
    if (reservationIds.has(id)) throw new TypeError('reservationIds must be unique');
    reservationIds.add(id);
  });
  const task = {
    taskId: input.taskId, taskType: input.taskType, priority: input.priority,
    payload: input.payload, durationMs: input.durationMs, createdAt: input.createdAt,
    status: 'AVAILABLE', ownerId: null, claimedAt: null, startedAt: null, endsAt: null,
    interruptedAt: null, completedAt: null, failedAt: null, cancelledAt: null,
    failureReason: null, cancellationReason: null, attemptCount: 0,
    reservationIds: input.reservationIds,
  };
  validateTask(task);
  return frozenTask(task);
}

function transition(task, input, allowed, status, timestampName, extra = () => ({}), eventName = status.toLowerCase(), earliest = () => task.createdAt) {
  validateTask(task); plain(input, 'input');
  if (!allowed.includes(task.status)) throw new RangeError(`cannot transition ${task.status} to ${status}`);
  const needsOwner = task.status !== 'AVAILABLE' || status !== 'CANCELLED';
  if (needsOwner) {
    requireStableIdentifier(input.actorId, 'actorId');
    if (task.ownerId !== null && task.ownerId !== input.actorId) throw new RangeError('actor does not own task');
  }
  clockInternals.requireTimestamp(input[timestampName], timestampName);
  if (input[timestampName] < earliest(task)) throw new RangeError(`${timestampName} must not move backward`);
  const nextValue = { ...task, status, ...extra(input) };
  validateTask(nextValue);
  const next = frozenTask(nextValue);
  return Object.freeze({ task: next, event: Object.freeze({ type: `task.${eventName}`, payload: Object.freeze({ task: next }) }) });
}

export function claimTask(task, input) {
  return transition(task, input, ['AVAILABLE', 'INTERRUPTED'], 'CLAIMED', 'claimedAt', args => ({
    ownerId: args.actorId, claimedAt: args.claimedAt, startedAt: null, endsAt: null,
    attemptCount: task.attemptCount + 1,
  }), 'claimed', value => value.interruptedAt ?? value.createdAt);
}

export function startTask(task, input) {
  return transition(task, input, ['CLAIMED'], 'ACTIVE', 'startedAt', args => {
    const endsAt = args.startedAt + task.durationMs;
    if (!Number.isSafeInteger(endsAt)) throw new RangeError('task end exceeds the safe integer range');
    return { startedAt: args.startedAt, endsAt };
  }, 'started', value => value.claimedAt);
}

export function interruptTask(task, input) {
  return transition(task, input, ['ACTIVE'], 'INTERRUPTED', 'interruptedAt', args => ({ interruptedAt: args.interruptedAt }), 'interrupted', value => value.startedAt);
}

export function completeTask(task, input) {
  return transition(task, input, ['ACTIVE'], 'COMPLETED', 'completedAt', args => ({ completedAt: args.completedAt }), 'completed', value => value.endsAt);
}

export function failTask(task, input) {
  if (typeof input?.reason !== 'string' || input.reason.trim() === '') throw new TypeError('reason must be nonblank');
  return transition(task, input, ['CLAIMED', 'ACTIVE', 'INTERRUPTED'], 'FAILED', 'failedAt', args => ({
    failedAt: args.failedAt, failureReason: args.reason,
  }), 'failed', value => Math.max(value.claimedAt, value.startedAt ?? 0, value.interruptedAt ?? 0));
}

export function cancelTask(task, input) {
  if (typeof input?.reason !== 'string' || input.reason.trim() === '') throw new TypeError('reason must be nonblank');
  return transition(task, input, ['AVAILABLE', 'CLAIMED', 'INTERRUPTED'], 'CANCELLED', 'cancelledAt', args => ({
    cancelledAt: args.cancelledAt, cancellationReason: args.reason,
  }), 'cancelled', value => Math.max(value.createdAt, value.claimedAt ?? 0, value.interruptedAt ?? 0));
}

export const taskInternals = Object.freeze({ validateTask, frozenTask });
