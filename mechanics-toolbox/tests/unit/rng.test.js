import test from 'node:test';
import assert from 'node:assert/strict';

import { createSeededRng } from '../../src/index.js';

test('Mulberry32 produces a repeatable sequence in the unit interval', () => {
  const first = createSeededRng(1);
  const second = createSeededRng(1);
  const expected = [0.6270739405881613, 0.002735721180215478, 0.5274470399599522];

  assert.deepEqual([first.next(), first.next(), first.next()], expected);
  assert.deepEqual([second.next(), second.next(), second.next()], expected);
  assert.equal(expected.every(value => value >= 0 && value < 1), true);
});

test('snapshot exposes the current unsigned 32-bit state', () => {
  const rng = createSeededRng(-1);
  assert.equal(rng.snapshot(), 0xffffffff);
  rng.next();
  assert.equal(rng.snapshot(), (0xffffffff + 0x6D2B79F5) >>> 0);
});

test('int uses inclusive integer bounds and rejects invalid bounds', () => {
  const rng = createSeededRng(1);
  assert.deepEqual([rng.int(2, 4), rng.int(2, 4), rng.int(2, 4)], [3, 2, 3]);
  assert.equal(createSeededRng(4).int(7, 7), 7);
  assert.throws(() => rng.int(2.5, 4), TypeError);
  assert.throws(() => rng.int(4, 3), RangeError);
});

test('pick deterministically selects from a non-empty array', () => {
  const rng = createSeededRng(1);
  assert.equal(rng.pick(['a', 'b', 'c']), 'b');
  assert.throws(() => rng.pick([]), RangeError);
  assert.throws(() => rng.pick('abc'), TypeError);
});

test('createSeededRng rejects non-integer seeds', () => {
  assert.throws(() => createSeededRng(1.5), TypeError);
  assert.throws(() => createSeededRng(Infinity), TypeError);
});
