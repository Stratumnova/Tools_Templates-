import { accept, reject } from '../core/contracts.js';
import { requireStableIdentifier } from '../core/identifiers.js';
import { copyImmutableData } from '../core/immutable-data.js';
import { createClock, clockInternals } from './clock.js';
import {
  cancelTask, claimTask, completeTask, createTask, failTask, interruptTask, startTask, taskInternals,
} from '../tasks/tasks.js';

function validateState(state) {
  if (!state || Array.isArray(state) || Object.getPrototypeOf(state) !== Object.prototype) throw new TypeError('state must be a plain object');
  createClock(state.clock?.now);
  for (const name of ['tasksById', 'offlineClaimsById']) {
    if (!state[name] || Array.isArray(state[name]) || Object.getPrototypeOf(state[name]) !== Object.prototype) {
      throw new TypeError(`${name} must be a plain object map`);
    }
  }
  for (const [id, task] of Object.entries(state.tasksById)) {
    taskInternals.validateTask(task);
    if (task.taskId !== id) throw new TypeError('task map key must match taskId');
  }
  for (const [id, claim] of Object.entries(state.offlineClaimsById)) {
    requireStableIdentifier(id, 'claimId');
    if (!claim || Array.isArray(claim) || Object.getPrototypeOf(claim) !== Object.prototype || claim.claimId !== id) {
      throw new TypeError('offline claim state is invalid');
    }
    clockInternals.requireTimestamp(claim.from, 'claim.from');
    clockInternals.requireTimestamp(claim.requestedTo, 'claim.requestedTo');
    clockInternals.requireTimestamp(claim.effectiveTo, 'claim.effectiveTo');
    if (!Number.isSafeInteger(claim.maxDurationMs) || claim.maxDurationMs <= 0) {
      throw new TypeError('claim.maxDurationMs must be a positive safe integer');
    }
    if (claim.requestedTo < claim.from) throw new TypeError('claim requestedTo must not precede from');
    const bounded = claim.from + claim.maxDurationMs;
    if (!Number.isSafeInteger(bounded)) throw new TypeError('stored claim bound exceeds the safe integer range');
    if (claim.effectiveTo !== Math.min(claim.requestedTo, bounded)) throw new TypeError('claim effectiveTo is inconsistent');
    const storedSummary = claim.summary;
    if (!storedSummary || Array.isArray(storedSummary) || Object.getPrototypeOf(storedSummary) !== Object.prototype
        || storedSummary.status !== 'PROCESSED'
        || storedSummary.requestedDurationMs !== claim.requestedTo - claim.from
        || storedSummary.processedDurationMs !== claim.effectiveTo - claim.from
        || storedSummary.clamped !== (claim.effectiveTo !== claim.requestedTo)
        || !Array.isArray(storedSummary.completedTaskIds)) {
      throw new TypeError('offline claim summary is inconsistent');
    }
    const completed = new Set();
    for (const taskId of storedSummary.completedTaskIds) {
      requireStableIdentifier(taskId, 'completedTaskId');
      if (completed.has(taskId)) throw new TypeError('completedTaskIds must be unique');
      completed.add(taskId);
    }
  }
  return copyImmutableData(state, 'state');
}

function summary(value) { return copyImmutableData(value, 'summary'); }

export function advanceOffline(state, input, context) {
  requireStableIdentifier(input?.claimId, 'claimId');
  const current = validateState(state);
  if (Object.hasOwn(current.offlineClaimsById, input.claimId)) {
    return Object.freeze({ events: Object.freeze([]), summary: summary({
      status: 'ALREADY_CLAIMED', requestedDurationMs: 0, processedDurationMs: 0,
      clamped: false, completedTaskIds: [],
    }), claimId: input.claimId });
  }
  for (const name of ['from', 'to']) clockInternals.requireTimestamp(input?.[name], name);
  if (!Number.isSafeInteger(input?.maxDurationMs) || input.maxDurationMs <= 0) throw new TypeError('maxDurationMs must be a positive safe integer');
  if (input.to < input.from) throw new RangeError('to must not precede from');
  if (input.from !== current.clock.now) throw new RangeError('from must equal clock.now');
  const bounded = input.from + input.maxDurationMs;
  if (!Number.isSafeInteger(bounded)) throw new RangeError('offline bound exceeds the safe integer range');
  const effectiveTo = Math.min(input.to, bounded);
  if (!context || typeof context.createEvent !== 'function') throw new TypeError('context.createEvent is required');
  const candidates = Object.values(current.tasksById).filter(task => (
    task.status === 'ACTIVE' && task.endsAt > input.from && task.endsAt <= effectiveTo
  )).sort((left, right) => left.endsAt - right.endsAt || (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));
  const completedTaskIds = candidates.map(task => task.taskId);
  const requestedDurationMs = input.to - input.from;
  const processedDurationMs = effectiveTo - input.from;
  const resultSummary = summary({ status: 'PROCESSED', requestedDurationMs, processedDurationMs,
    clamped: effectiveTo !== input.to, completedTaskIds });
  const events = [context.createEvent('offline.claim_recorded', {
    claimId: input.claimId, from: input.from, requestedTo: input.to, effectiveTo,
    maxDurationMs: input.maxDurationMs, summary: resultSummary,
  })];
  for (const task of candidates) {
    const completed = completeTask(task, { actorId: task.ownerId, completedAt: task.endsAt });
    events.push(context.createEvent(completed.event.type, completed.event.payload));
  }
  events.push(context.createEvent('clock.advanced', { from: input.from, to: effectiveTo }));
  return Object.freeze({ events: Object.freeze(events), summary: resultSummary, claimId: input.claimId });
}

function replaceTask(state, task) {
  return { ...state, tasksById: { ...state.tasksById, [task.taskId]: task } };
}

export function createTimeTaskHandlers() {
  const rejectError = operation => (state, command, context) => {
    try { return operation(state, command, context); }
    catch (error) { return reject('INVALID_ARGUMENT', error.message, {}); }
  };
  const taskHandler = operation => ({
    decide: rejectError((state, command, context) => {
      const task = operation(Object.hasOwn(state.tasksById, command.payload.taskId)
        ? state.tasksById[command.payload.taskId] : undefined, { ...command.payload, actorId: command.actorId });
      return accept([context.createEvent(task.event.type, task.event.payload)]);
    }),
    reduce: (state, event) => replaceTask(state, event.payload.task),
  });
  return {
    'clock.advance': {
      decide: rejectError((state, command, context) => {
        const to = state.clock.now + command.payload.deltaMs;
        createClock(to);
        return accept([context.createEvent('clock.advanced', { from: state.clock.now, to })]);
      }),
      reduce: (state, event) => ({ ...state, clock: createClock(event.payload.to) }),
    },
    'task.create': {
      decide: rejectError((state, command, context) => {
        const task = createTask(command.payload);
        if (Object.hasOwn(state.tasksById, task.taskId)) throw new RangeError('task already exists');
        return accept([context.createEvent('task.created', { task })]);
      }),
      reduce: (state, event) => replaceTask(state, event.payload.task),
    },
    'task.claim': taskHandler(claimTask),
    'task.start': taskHandler(startTask),
    'task.interrupt': taskHandler(interruptTask),
    'task.complete': taskHandler(completeTask),
    'task.fail': taskHandler(failTask),
    'task.cancel': taskHandler(cancelTask),
    'offline.advance': {
      decide: rejectError((state, command, context) => accept(advanceOffline(state, command.payload, context).events)),
      reduce(state, event) {
        if (event.type === 'offline.claim_recorded') return {
          ...state, offlineClaimsById: { ...state.offlineClaimsById, [event.payload.claimId]: event.payload },
        };
        if (event.type === 'task.completed') return replaceTask(state, event.payload.task);
        if (event.type === 'clock.advanced') return { ...state, clock: createClock(event.payload.to) };
        return state;
      },
    },
  };
}
