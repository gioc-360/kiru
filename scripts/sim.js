// Tuning readout: runs the careful and masher bots from test/engine.test.js over
// seeds 1-200, plus a passive round per seed for the bomb fraction by phase.
import { CONFIG, createRng, createRound, itemPos, segmentHitsCircle } from '../public/shared/engine.js';

const SEEDS = 200;

function aliveAt(item, t) {
  return item.t0 <= t && t < item.tEnd;
}

function hitRadius(item) {
  return item.size * CONFIG.HIT_SCALE;
}

function runPassive(seed) {
  const round = createRound(seed);
  const spawns = [];
  for (let t = 0; t <= CONFIG.ROUND_SECONDS + 1e-9; t += 1 / 60) spawns.push(...round.update(t));
  round.update(CONFIG.ROUND_SECONDS);
  return spawns;
}

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
  return { total: r.score, chaosNet: r.score - scoreAt14, stars: r.stats.stars };
}

const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)];
const bands = (xs) => `p10=${quantile(xs, 0.1)} median=${quantile(xs, 0.5)} p90=${quantile(xs, 0.9)}`;

const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);
const careful = seeds.map((s) => playBot(s, 'careful'));
const masher = seeds.map((s) => playBot(s, 'masher'));

const count = Object.fromEntries(CONFIG.PHASES.map((p) => [p.name, { bomb: 0, food: 0 }]));
for (const seed of seeds) {
  for (const s of runPassive(seed)) {
    if (s.kind !== 'star') count[CONFIG.PHASES.find((p) => s.t0 >= p.start && s.t0 < p.end).name][s.kind]++;
  }
}
const frac = (c) => (c.bomb + c.food ? c.bomb / (c.bomb + c.food) : 0).toFixed(3);

const row = (label, runs) =>
  `${label}total  ${bands(runs.map((x) => x.total))}   chaos-net  ${bands(runs.map((x) => x.chaosNet))}`;

console.log(`seeds 1-${SEEDS}`);
console.log(row('careful  ', careful));
console.log(row('masher   ', masher));
console.log(`bomb fraction (passive)  ${CONFIG.PHASES.map((p) => `${p.name}=${frac(count[p.name])}`).join(' ')}`);
console.log(`star sliced by careful bot: ${careful.filter((x) => x.stars > 0).length}/${SEEDS}`);
