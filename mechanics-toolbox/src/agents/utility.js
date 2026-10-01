import { copyImmutableData } from '../core/immutable-data.js';
import { requireStableIdentifier } from '../core/identifiers.js';

const COMPONENTS = Object.freeze([
  'needPressure',
  'routinePriority',
  'skillFit',
  'memoryEvidence',
  'taskUrgency',
  'switchingCost',
  'modifiers',
]);

function requireSafeInteger(value, name, { signed = false } = {}) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) {
    throw new TypeError(`${name} must be ${signed ? 'a' : 'a nonnegative'} safe integer`);
  }
  return value;
}

function validateWeights(weights) {
  const copy = copyImmutableData(weights, 'weights');
  if (copy === null || Array.isArray(copy) || Object.getPrototypeOf(copy) !== Object.prototype) {
    throw new TypeError('weights must be a plain object');
  }
  const actual = Object.keys(copy).sort();
  const expected = [...COMPONENTS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError('weights must define every scoring component exactly once');
  }
  for (const name of COMPONENTS) requireSafeInteger(copy[name], `weights.${name}`);
  return copy;
}

export function scoreCandidate(candidate, weights) {
  const input = copyImmutableData(candidate, 'candidate');
  if (input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError('candidate must be a plain object');
  }
  requireStableIdentifier(input.candidateId, 'candidate.candidateId');
  requireSafeInteger(input.priority, 'candidate.priority');
  for (const name of COMPONENTS) {
    requireSafeInteger(input[name], `candidate.${name}`, { signed: name === 'modifiers' });
  }
  const validatedWeights = validateWeights(weights);
  const components = {};
  let total = 0;
  for (const name of COMPONENTS) {
    let weighted = input[name] * validatedWeights[name];
    if (!Number.isSafeInteger(weighted)) throw new TypeError(`${name} multiplication exceeds safe integer range`);
    if (name === 'switchingCost') weighted = -weighted;
    components[name] = weighted;
    total += weighted;
    if (!Number.isSafeInteger(total)) throw new TypeError('utility total exceeds safe integer range');
  }
  return Object.freeze({
    candidateId: input.candidateId,
    priority: input.priority,
    components: Object.freeze(components),
    total,
  });
}

export function rankCandidates(candidates, weights) {
  const copy = copyImmutableData(candidates, 'candidates');
  if (!Array.isArray(copy)) throw new TypeError('candidates must be an array');
  const seen = new Set();
  const ranked = copy.map((candidate) => {
    const score = scoreCandidate(candidate, weights);
    if (seen.has(score.candidateId)) throw new TypeError(`duplicate candidate ID ${score.candidateId}`);
    seen.add(score.candidateId);
    return score;
  });
  ranked.sort((left, right) => {
    if (left.total !== right.total) return left.total > right.total ? -1 : 1;
    if (left.priority !== right.priority) return left.priority > right.priority ? -1 : 1;
    return left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0;
  });
  return Object.freeze(ranked);
}
