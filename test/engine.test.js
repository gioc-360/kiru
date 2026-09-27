// Acceptance contract for the shared game engine.
// Written before the engine existed. Do not edit to make
// the build pass: if an assertion is wrong, fix the spec first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, createRng, createRound, itemPos, segmentHitsCircle } from '../public/shared/engine.js';

const DT = 1 / 60;

function runPassive(seed) {
  const round = createRound(seed);
  const spawns = [];
  for (let t = 0; t <= CONFIG.ROUND_SECONDS + 1e-9; t += DT) spawns.push(...round.update(t));
  round.update(CONFIG.ROUND_SECONDS);
  return { round, spawns };
}

function aliveAt(item, t) {
  return item.t0 <= t && t < item.tEnd;
}

function hitRadius(item) {
  return item.size * CONFIG.HIT_SCALE;
}

// Advance a round until an item of `kind` is on screen, then return it with its position.
function advanceUntilVisible(round, kind, fromT = 0) {
  for (let t = fromT; t < CONFIG.ROUND_SECONDS; t += DT) {
    round.update(t);
    for (const item of round.items.values()) {
      if (item.kind !== kind || !aliveAt(item, t)) continue;
      const p = itemPos(item, t);
      if (p.y > 0.3 && p.y < 1.5) return { item, t, p };
    }
  }
  return null;
}

// A tiny slash straight through the item's centre.
function slashThrough(round, p, t) {
  return round.slash(p.x - 0.006, p.y, p.x + 0.006, p.y, t);
}

test('CONFIG carries the literal tuning values', () => {
  assert.equal(CONFIG.W, 1);
  assert.equal(CONFIG.H, 1.75);
  assert.equal(CONFIG.ROUND_SECONDS, 21);
  assert.deepEqual(CONFIG.PHASES.map((p) => [p.name, p.start, p.end, p.bombP]), [
    ['warmup', 0, 6, 0],
    ['main', 6, 14, 0.22],
    ['chaos', 14, 21, 0.45],
  ]);
  assert.deepEqual(CONFIG.POINTS, { food: 10, bomb: -30, star: 10 });
  assert.equal(CONFIG.FRENZY.seconds, 4);
  assert.equal(CONFIG.FRENZY.mult, 2);
});

test('createRng is deterministic and in [0,1)', () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test('same seed produces the same spawn stream', () => {
  const a = runPassive(7).spawns;
  const b = runPassive(7).spawns;
  assert.ok(a.length > 20, `expected a full round of spawns, got ${a.length}`);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(runPassive(8).spawns));
});

test('phase boundaries', () => {
  const r = createRound(1);
  assert.equal(r.phaseAt(0), 'warmup');
  assert.equal(r.phaseAt(5.99), 'warmup');
  assert.equal(r.phaseAt(6), 'main');
  assert.equal(r.phaseAt(13.99), 'main');
  assert.equal(r.phaseAt(14), 'chaos');
  assert.equal(r.phaseAt(20.99), 'chaos');
});

test('spawn items honour the wire contract', () => {
  const { spawns } = runPassive(3);
  const ids = new Set();
  for (const it of spawns) {
    assert.ok(Number.isInteger(it.id) && !ids.has(it.id), 'unique integer id');
    ids.add(it.id);
    assert.ok(['food', 'bomb', 'star', 'boss'].includes(it.kind));
    if (it.kind === 'boss') {
      // Added 2026-09-26 at the builder's request (the original Kiru's bento boss).
      assert.equal(it.glyph, CONFIG.BOSS.glyph);
      assert.ok(it.y0 > CONFIG.H && it.vy < 0 && it.g < 0, 'boss drifts down from above, then floats back up');
      assert.equal(it.tEnd, CONFIG.ROUND_SECONDS + 1);
      assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(it))).sort(), Object.keys(it).sort(), 'JSON-safe');
      continue;
    }
    if (it.kind === 'food') assert.ok(CONFIG.FOODS.includes(it.glyph));
    if (it.kind === 'bomb') assert.equal(it.glyph, CONFIG.BOMB);
    if (it.kind === 'star') assert.equal(it.glyph, CONFIG.STAR);
    for (const k of ['t0', 'x0', 'y0', 'vx', 'vy', 'g', 'spin', 'rot0', 'size', 'tEnd']) {
      assert.equal(typeof it[k], 'number', `${k} is a number`);
      assert.ok(Number.isFinite(it[k]), `${k} is finite`);
    }
    assert.ok(it.t0 >= CONFIG.SPAWN_START - 1e-9 && it.t0 <= CONFIG.SPAWN_END + 1e-9);
    assert.ok(it.x0 >= 0.15 - 1e-9 && it.x0 <= 0.85 + 1e-9);
    assert.equal(it.y0, CONFIG.Y0);
    assert.ok(it.g > 0 && it.vy > 0 && it.tEnd > it.t0);
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(it))).sort(), Object.keys(it).sort(), 'JSON-safe');
  }
});

test('itemPos is the closed-form ballistic path (y up, gravity down)', () => {
  const { spawns } = runPassive(4);
  const it = spawns[0];
  const p0 = itemPos(it, it.t0);
  assert.ok(Math.abs(p0.x - it.x0) < 1e-9 && Math.abs(p0.y - it.y0) < 1e-9);
  const p1 = itemPos(it, it.t0 + 1);
  assert.ok(Math.abs(p1.x - (it.x0 + it.vx)) < 1e-9);
  assert.ok(Math.abs(p1.y - (it.y0 + it.vy - it.g / 2)) < 1e-9);
  assert.ok(Math.abs(p1.rot - (it.rot0 + it.spin)) < 1e-9);
  const pe = itemPos(it, it.tEnd);
  assert.ok(Math.abs(pe.y - CONFIG.Y_CULL) < 1e-6, 'tEnd is when the item falls back to Y_CULL');
  const apex = it.y0 + (it.vy * it.vy) / (2 * it.g);
  assert.ok(apex > 0.6 && apex < CONFIG.H, `apex ${apex} is on screen`);
});

test('warm-up has no bombs', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const bombs = runPassive(seed).spawns.filter((s) => s.t0 < 6 && s.kind === 'bomb');
    assert.equal(bombs.length, 0, `seed ${seed}`);
  }
});

test('main phase has some bombs and the final stretch is nearly half bombs', () => {
  const count = { main: { bomb: 0, food: 0 }, chaos: { bomb: 0, food: 0 } };
  for (let seed = 1; seed <= 200; seed++) {
    for (const s of runPassive(seed).spawns) {
      if (s.kind === 'star') continue;
      const phase = s.t0 >= 14 ? 'chaos' : s.t0 >= 6 ? 'main' : null;
      if (phase) count[phase][s.kind]++;
    }
  }
  const frac = (c) => c.bomb / (c.bomb + c.food);
  assert.ok(frac(count.main) >= 0.17 && frac(count.main) <= 0.27, `main bomb fraction ${frac(count.main)}`);
  assert.ok(frac(count.chaos) >= 0.4 && frac(count.chaos) <= 0.49, `chaos bomb fraction ${frac(count.chaos)}`);
});

test('exactly one star per round, inside the star window', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const stars = runPassive(seed).spawns.filter((s) => s.kind === 'star');
    assert.equal(stars.length, 1, `seed ${seed}`);
    assert.ok(stars[0].t0 >= CONFIG.STAR_WINDOW[0] && stars[0].t0 <= CONFIG.STAR_WINDOW[1] + 0.5, `seed ${seed} t0 ${stars[0].t0}`);
  }
});

test('the round ends at 21 seconds and ignores later slashes', () => {
  const { round } = runPassive(5);
  assert.equal(round.over, true);
  assert.deepEqual(round.slash(0, 0.8, 1, 0.8, 21.2), []);
});

test('food is +10, a bomb is -30, and the score never drops below zero', () => {
  const r = createRound(11);
  const f = advanceUntilVisible(r, 'food');
  assert.ok(f, 'a food appears');
  const hits = slashThrough(r, f.p, f.t);
  const fh = hits.find((h) => h.id === f.item.id);
  assert.ok(fh, 'slash through a food centre hits it');
  assert.equal(fh.kind, 'food');
  assert.equal(fh.points, 10);
  assert.equal(fh.mult, 1);
  assert.equal(fh.t, f.t);
  assert.equal(r.score, hits.at(-1).score);
  assert.ok(!r.items.has(f.item.id), 'a sliced item leaves the live set');
  assert.equal(slashThrough(r, f.p, f.t).find((h) => h.id === f.item.id), undefined, 'cannot be hit twice');

  const b = advanceUntilVisible(r, 'bomb', f.t);
  assert.ok(b, 'a bomb appears');
  const before = r.score;
  const bhits = slashThrough(r, b.p, b.t);
  const bi = bhits.findIndex((h) => h.id === b.item.id);
  assert.ok(bi >= 0, 'slash through a bomb centre hits it');
  const bh = bhits[bi];
  const prev = bi > 0 ? bhits[bi - 1].score : before;
  assert.equal(bh.points, -30);
  assert.equal(bh.score, Math.max(0, prev - 30), 'score = max(0, score + raw)');
  assert.ok(r.score >= 0);
});

test('a slash shorter than MIN_SLASH hits nothing', () => {
  const r = createRound(12);
  const f = advanceUntilVisible(r, 'food');
  assert.deepEqual(r.slash(f.p.x, f.p.y, f.p.x + CONFIG.MIN_SLASH / 2, f.p.y, f.t), []);
});

test('the star doubles food points and starts a 4 second frenzy with no bombs', () => {
  const r = createRound(21);
  const s = advanceUntilVisible(r, 'star');
  assert.ok(s, 'the star appears');
  const sh = slashThrough(r, s.p, s.t).find((h) => h.id === s.item.id);
  assert.ok(sh, 'slash through the star hits it');
  assert.equal(sh.kind, 'star');
  assert.equal(sh.points, 10);
  assert.equal(r.frenzyActive(s.t + 0.1), true);
  assert.equal(r.multiplierAt(s.t + 1), 2);
  assert.equal(r.frenzyActive(s.t + 4.01), false);
  assert.equal(r.multiplierAt(s.t + 4.01), 1);

  const spawned = [];
  for (let t = s.t; t < s.t + 4; t += DT) spawned.push(...r.update(t));
  const inFrenzy = spawned.filter((x) => x.t0 >= s.t && x.t0 < s.t + 4);
  assert.ok(inFrenzy.length >= 8, `frenzy is a flood of food (${inFrenzy.length} spawns)`);
  assert.ok(inFrenzy.every((x) => x.kind === 'food'), 'no bombs spawn during frenzy');

  const f = advanceUntilVisible(r, 'food', s.t + 0.5);
  assert.ok(f.t < s.t + 4, 'a food is sliceable inside the frenzy');
  const fh = slashThrough(r, f.p, f.t).find((h) => h.id === f.item.id);
  assert.equal(fh.points, 20);
  assert.equal(fh.mult, 2);
});

test('segmentHitsCircle geometry', () => {
  assert.equal(segmentHitsCircle(0, 0, 1, 0, 0.5, 0.05, 0.06), true);
  assert.equal(segmentHitsCircle(0, 0, 1, 0, 0.5, 0.2, 0.06), false);
  assert.equal(segmentHitsCircle(0, 0, 0.4, 0, 0.5, 0, 0.06), false, 'beyond the segment end');
  assert.equal(segmentHitsCircle(0, 0, 0.46, 0, 0.5, 0, 0.06), true, 'endpoint inside radius');
});

// Decision architecture: in the final stretch, indiscriminate slashing must
// lose points and careful slashing must gain them. If this fails, the chaos
// phase has no decision in it.
function playBot(seed, style) {
  const r = createRound(seed);
  const rng = createRng(seed * 7919);
  let last = -1;
  let scoreAt14 = null;
  for (let t = 0; t < CONFIG.ROUND_SECONDS; t += 1 / 30) {
    r.update(t);
    if (scoreAt14 === null && t >= 14) scoreAt14 = r.score;
    if (t - last < 1 / 3) continue;
    if (style === 'masher') {
      const y = 0.3 + rng() * 1.1;
      r.slash(0, y, 1, y, t);
      last = t;
      continue;
    }
    const live = [...r.items.values()].filter((it) => aliveAt(it, t));
    const bombs = live.filter((it) => it.kind === 'bomb').map((it) => ({ it, p: itemPos(it, t) }));
    const targets = live
      .filter((it) => it.kind !== 'bomb')
      .map((it) => ({ it, p: itemPos(it, t) }))
      .filter(({ p }) => p.y > 0.15 && p.y < 1.6)
      .sort((a, b) => a.p.y - b.p.y);
    for (const { p } of targets) {
      const seg = [p.x - 0.03, p.y, p.x + 0.03, p.y];
      if (bombs.some((b) => segmentHitsCircle(...seg, b.p.x, b.p.y, hitRadius(b.it) + 0.02))) continue;
      r.slash(...seg, t);
      last = t;
      break;
    }
  }
  r.update(CONFIG.ROUND_SECONDS);
  return { total: r.score, chaosNet: r.score - scoreAt14 };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('decision architecture: careful play wins the final stretch, mashing loses it', () => {
  const careful = [];
  const masher = [];
  for (let seed = 1; seed <= 100; seed++) {
    careful.push(playBot(seed, 'careful'));
    masher.push(playBot(seed, 'masher'));
  }
  const cChaos = median(careful.map((x) => x.chaosNet));
  const mChaos = median(masher.map((x) => x.chaosNet));
  const cTotal = median(careful.map((x) => x.total));
  assert.ok(cChaos > 0, `careful chaos net median ${cChaos}`);
  assert.ok(mChaos < 0, `masher chaos net median ${mChaos}`);
  assert.ok(cTotal >= 120 && cTotal <= 900, `careful total median ${cTotal}`);
});

// The bento boss, added 2026-09-26 at the builder's request.
test('the bento boss enters once at the final stretch and takes 50 paced hits', () => {
  const { spawns } = runPassive(9);
  const bosses = spawns.filter((s) => s.kind === 'boss');
  assert.equal(bosses.length, 1, 'exactly one boss per round');
  assert.ok(bosses[0].t0 >= CONFIG.BOSS.at && bosses[0].t0 < CONFIG.BOSS.at + 0.2);
  const p = itemPos(bosses[0], bosses[0].t0 + 4);
  assert.ok(p.y > 0.5 && p.y < 1.2, `boss bottoms out mid-screen (${p.y})`);

  const r = createRound(9);
  let boss = null;
  let seen = 0;
  for (let t = 0; t < 16 && !boss; t += DT) {
    seen = t;
    r.update(t);
    boss = [...r.items.values()].find((it) => it.kind === 'boss' && itemPos(it, t).y < 1.5) || null;
  }
  assert.ok(boss, 'boss on screen by 16 s');
  const slashBoss = (t) => {
    const q = itemPos(boss, t);
    return r.slash(q.x - 0.05, q.y, q.x + 0.05, q.y, t).filter((h) => h.kind === 'boss');
  };
  const t0 = seen + DT;
  const step = CONFIG.BOSS.cooldown + 1e-3;
  assert.equal(slashBoss(t0).length, 1);
  assert.equal(slashBoss(t0 + 0.05).length, 0, 'a second hit inside the cooldown does not count');
  const h = slashBoss(t0 + step);
  assert.equal(h.length, 1);
  assert.equal(h[0].points, CONFIG.BOSS.points);
  assert.equal(h[0].left, CONFIG.BOSS.hits - 2);
  assert.ok(r.items.has(boss.id), 'boss survives a hit');
  let t = t0 + step;
  let last;
  for (let i = 2; i < CONFIG.BOSS.hits; i++) {
    t += step;
    [last] = slashBoss(t);
  }
  assert.ok(t < CONFIG.ROUND_SECONDS, 'a fast player can knock it out before time runs out');
  assert.equal(last.left, 0);
  assert.ok(!r.items.has(boss.id) && r.boss.ko, 'the 50th hit knocks it out');
});

test('the boss never blocks other spawns', () => {
  const withBoss = runPassive(11).spawns.filter((s) => s.kind !== 'boss').length;
  assert.ok(withBoss > 0);
  const chaos = runPassive(11).spawns.filter((s) => s.kind !== 'boss' && s.t0 >= CONFIG.BOSS.at);
  assert.ok(chaos.length >= 10, `final stretch still spawns (${chaos.length})`);
});
