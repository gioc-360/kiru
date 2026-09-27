// Engine checks beyond the acceptance contract: failure paths and edge rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, createRound, itemPos, segmentHitsCircle } from '../public/shared/engine.js';

// A hand-placed item that sits still at (x, y) for the whole round.
function still(id, kind, x, y) {
  return {
    id, kind, glyph: kind === 'food' ? CONFIG.FOODS[0] : kind === 'bomb' ? CONFIG.BOMB : CONFIG.STAR,
    t0: 0, x0: x, y0: y, vx: 0, vy: 0, g: 1e-12, spin: 0, rot0: 0, size: 0.1, tEnd: 1e6,
  };
}

test('update with a time earlier than the last call spawns nothing and does not throw', () => {
  const r = createRound(9);
  const first = r.update(10);
  assert.ok(first.length > 0);
  const liveBefore = [...r.items.keys()];
  assert.deepEqual(r.update(5), []);
  assert.deepEqual(r.update(-1), []);
  assert.deepEqual([...r.items.keys()], liveBefore);
  assert.equal(r.over, false);
});

test('one coarse update yields the same spawn stream as frame-by-frame updates', () => {
  const fine = createRound(31);
  const fineSpawns = [];
  for (let t = 0; t <= 21; t += 1 / 60) fineSpawns.push(...fine.update(t));
  fineSpawns.push(...fine.update(21));
  const coarseSpawns = createRound(31).update(21);
  assert.equal(JSON.stringify(coarseSpawns), JSON.stringify(fineSpawns));
});

test('items leave the live set at tEnd', () => {
  const r = createRound(2);
  const [it] = r.update(CONFIG.SPAWN_START);
  assert.ok(r.items.has(it.id));
  r.update(it.tEnd - 1e-6);
  assert.ok(r.items.has(it.id));
  r.update(it.tEnd);
  assert.ok(!r.items.has(it.id));
});

test('slash after the round is over returns [] and leaves the score alone', () => {
  const r = createRound(5);
  r.items.set(1, still(1, 'food', 0.5, 0.8));
  r.update(21);
  assert.equal(r.over, true);
  assert.deepEqual(r.slash(0, 0.8, 1, 0.8, 20.5), [], 'over wins even with an earlier t');
  assert.equal(r.score, 0);
});

test('slash at t >= 21 returns [] even before update reaches 21', () => {
  const r = createRound(5);
  r.items.set(1, still(1, 'food', 0.5, 0.8));
  assert.deepEqual(r.slash(0, 0.8, 1, 0.8, 21), []);
  assert.ok(r.items.has(1));
});

test('hits are ordered by distance from the slash start, in either direction', () => {
  const place = (r) => {
    r.items.set(1, still(1, 'food', 0.8, 0.8));
    r.items.set(2, still(2, 'food', 0.2, 0.8));
    r.items.set(3, still(3, 'food', 0.5, 0.8));
  };
  const a = createRound(1);
  place(a);
  assert.deepEqual(a.slash(0, 0.8, 1, 0.8, 1).map((h) => h.id), [2, 3, 1]);
  const b = createRound(1);
  place(b);
  assert.deepEqual(b.slash(1, 0.8, 0, 0.8, 1).map((h) => h.id), [1, 3, 2]);
  assert.deepEqual(b.stats, { foods: 3, bombs: 0, stars: 0 });
});

test('a bomb at score 0 stays at 0 and a bomb during frenzy is not multiplied', () => {
  const r = createRound(1);
  r.items.set(1, still(1, 'bomb', 0.5, 0.8));
  const [b0] = r.slash(0, 0.8, 1, 0.8, 1);
  assert.deepEqual(b0, { id: 1, kind: 'bomb', points: -30, score: 0, mult: 1, t: 1 });

  r.items.set(2, still(2, 'star', 0.5, 0.5));
  r.items.set(3, still(3, 'food', 0.3, 0.5));
  r.items.set(4, still(4, 'bomb', 0.9, 0.5));
  const hits = r.slash(0.5, 0.5, 1, 0.5, 2);
  assert.deepEqual(hits.map((h) => [h.kind, h.points, h.mult, h.score]), [
    ['star', 10, 1, 10],
    ['bomb', -30, 2, 0],
  ]);
  const [f] = r.slash(0, 0.5, 0.4, 0.5, 3);
  assert.deepEqual([f.kind, f.points, f.mult, f.score], ['food', 20, 2, 20]);
  assert.equal(r.frenzyActive(6), false);
  assert.deepEqual(r.stats, { foods: 1, bombs: 2, stars: 1 });
});

test('segmentHitsCircle treats a zero-length segment as a point', () => {
  assert.equal(segmentHitsCircle(0.5, 0.5, 0.5, 0.5, 0.52, 0.5, 0.03), true);
  assert.equal(segmentHitsCircle(0.5, 0.5, 0.5, 0.5, 0.6, 0.5, 0.03), false);
});

test('itemPos is pure: same inputs, same output, item untouched', () => {
  const [it] = createRound(3).update(CONFIG.SPAWN_START);
  const snapshot = JSON.stringify(it);
  assert.deepEqual(itemPos(it, 2), itemPos(it, 2));
  assert.equal(JSON.stringify(it), snapshot);
});
