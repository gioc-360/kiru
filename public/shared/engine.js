// Kiru game rules. Pure ES module: no DOM, no imports. The phone and the host
// both import it, so everything here must stay deterministic and side-effect free.
// World units, y up from the bottom edge (I1); round time in seconds (I2).

export const CONFIG = {
  W: 1, H: 1.75, ROUND_SECONDS: 21,
  SPAWN_START: 0.6,          // first spawn opportunity (s)
  SPAWN_END: 20.3,           // no spawn opportunity after this (s)
  G: 0.875,                  // gravity, world/s²
  Y0: -0.26, Y_CULL: -0.35,
  LAUNCH_SCALE: 1.75,        // launch ranges below are fractions of H per second: vy = rand(launch) * LAUNCH_SCALE
  PHASES: [
    { name: 'warmup', start: 0,  end: 6,  interval: 0.45, maxLive: 4, bombP: 0,    launch: [0.82, 0.90] },
    { name: 'main',   start: 6,  end: 14, interval: 0.30, maxLive: 5, bombP: 0.22, launch: [0.85, 0.93] },
    { name: 'chaos',  start: 14, end: 21, interval: 0.15, maxLive: 8, bombP: 0.45, launch: [0.88, 0.96] },
  ],
  FRENZY: { seconds: 4, mult: 2, intervalScale: 0.5, maxLiveBonus: 4, gravityScale: 1.5, launchScale: 1.3 },
  STAR_WINDOW: [6.5, 10],     // frenzy (4 s) always ends before the chaos phase starts at 14 s
  POINTS: { food: 10, bomb: -30, star: 10 },
  SIZE: { food: [0.11, 0.15], bomb: 0.13, star: 0.12 },
  HIT_SCALE: 0.7,
  MIN_SLASH: 0.01,
  FOODS: ['🍣', '🍙', '🍡', '🍤', '🍥', '🍘', '🍢', '🍜'],
  BOMB: '💣', STAR: '⭐',
  // The bento boss (from the original Kiru): drifts down from above the screen
  // at the start of the final stretch, bottoms out mid-screen, floats back up,
  // and takes HITS slashes (one per COOLDOWN) before it is knocked out.
  BOSS: { at: 14.5, hits: 50, points: 5, cooldown: 0.08, size: 0.34, glyph: '🍱',
    x0: 0.5, y0: 1.95, vy: -0.575, g: -0.144, spin: 0.35 },
};

// mulberry32
export function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// I3: the only motion code. Closed form, never integrated.
export function itemPos(item, t) {
  const dt = t - item.t0;
  return {
    x: item.x0 + item.vx * dt,
    y: item.y0 + item.vy * dt - 0.5 * item.g * dt * dt,
    rot: item.rot0 + item.spin * dt,
  };
}

// True iff the segment (ax,ay)-(bx,by) passes within r of (cx,cy).
export function segmentHitsCircle(ax, ay, bx, by, cx, cy, r) {
  return distSqToSegment(ax, ay, bx, by, cx, cy) <= r * r;
}

// Fraction along the segment of the point nearest (cx,cy), clamped to [0, 1].
function projectOnSegment(ax, ay, bx, by, cx, cy) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  const u = ((cx - ax) * dx + (cy - ay) * dy) / len2;
  return Math.min(1, Math.max(0, u));
}

function distSqToSegment(ax, ay, bx, by, cx, cy) {
  const u = projectOnSegment(ax, ay, bx, by, cx, cy);
  const px = ax + u * (bx - ax) - cx;
  const py = ay + u * (by - ay) - cy;
  return px * px + py * py;
}

function phaseFor(t) {
  for (const p of CONFIG.PHASES) if (t >= p.start && t < p.end) return p;
  return t < CONFIG.PHASES[0].start ? CONFIG.PHASES[0] : CONFIG.PHASES[CONFIG.PHASES.length - 1];
}

export function createRound(seed) {
  const rng = createRng(seed);
  const starT = CONFIG.STAR_WINDOW[0] + rng() * (CONFIG.STAR_WINDOW[1] - CONFIG.STAR_WINDOW[0]);
  let starSpawned = false;
  let bossSpawned = false;
  let bossLastHit = -Infinity;
  let frenzyStart = null;
  let nextTs = CONFIG.SPAWN_START;
  let nextId = 1;

  const round = {
    seed,
    score: 0,
    over: false,
    items: new Map(),
    stats: { foods: 0, bombs: 0, stars: 0 },
    boss: { hits: 0, ko: false },
    phaseAt,
    frenzyActive,
    multiplierAt,
    update,
    slash,
  };

  function phaseAt(t) {
    return phaseFor(t).name;
  }

  function frenzyActive(t) {
    return frenzyStart !== null && frenzyStart <= t && t < frenzyStart + CONFIG.FRENZY.seconds;
  }

  function multiplierAt(t) {
    return frenzyActive(t) ? CONFIG.FRENZY.mult : 1;
  }

  function liveAt(ts) {
    let n = 0;
    for (const it of round.items.values()) if (it.kind !== 'boss' && it.t0 <= ts && ts < it.tEnd) n++;
    return n;
  }

  function makeItem(kind, ts, phase, frenzy) {
    const glyph = kind === 'food' ? CONFIG.FOODS[Math.floor(rng() * CONFIG.FOODS.length)]
      : kind === 'bomb' ? CONFIG.BOMB : CONFIG.STAR;
    const x0 = 0.15 + rng() * 0.70;
    const y0 = CONFIG.Y0;
    const vx = (0.5 - x0) * 0.35 + (rng() * 0.12 - 0.06);
    const [lo, hi] = phase.launch;
    const vy = (lo + rng() * (hi - lo)) * CONFIG.LAUNCH_SCALE * (frenzy ? CONFIG.FRENZY.launchScale : 1);
    const g = CONFIG.G * (frenzy ? CONFIG.FRENZY.gravityScale : 1);
    const spin = (rng() * 2 - 1) * 2.5;
    const rot0 = rng() * 2 * Math.PI;
    const size = kind === 'food' ? CONFIG.SIZE.food[0] + rng() * (CONFIG.SIZE.food[1] - CONFIG.SIZE.food[0])
      : CONFIG.SIZE[kind];
    const tEnd = ts + (vy + Math.sqrt(vy * vy + 2 * g * (y0 - CONFIG.Y_CULL))) / g;
    return { id: nextId++, kind, glyph, t0: ts, x0, y0, vx, vy, g, spin, rot0, size, tEnd };
  }

  // No rng draws, so every other item in the round is the same with or without it.
  function makeBoss(ts) {
    const B = CONFIG.BOSS;
    return { id: nextId++, kind: 'boss', glyph: B.glyph, t0: ts, x0: B.x0, y0: B.y0, vx: 0, vy: B.vy, g: B.g,
      spin: B.spin, rot0: 0, size: B.size, tEnd: CONFIG.ROUND_SECONDS + 1 };
  }

  // One spawn opportunity at scheduled time ts. Returns the new item or null.
  function spawnAt(ts) {
    const phase = phaseFor(ts);
    const frenzy = frenzyActive(ts);
    if (!starSpawned && ts >= starT) {
      starSpawned = true;
      return makeItem('star', ts, phase, frenzy);
    }
    const maxLive = phase.maxLive + (frenzy ? CONFIG.FRENZY.maxLiveBonus : 0);
    if (liveAt(ts) >= maxLive) return null;
    const bombP = frenzy ? 0 : phase.bombP;
    return makeItem(rng() < bombP ? 'bomb' : 'food', ts, phase, frenzy);
  }

  function update(t) {
    const spawned = [];
    while (nextTs <= t && nextTs <= CONFIG.SPAWN_END) {
      const ts = nextTs;
      if (!bossSpawned && ts >= CONFIG.BOSS.at) {
        bossSpawned = true;
        const boss = makeBoss(ts);
        round.items.set(boss.id, boss);
        spawned.push(boss);
      }
      const item = spawnAt(ts);
      if (item) {
        round.items.set(item.id, item);
        spawned.push(item);
      }
      nextTs = ts + phaseFor(ts).interval * (frenzyActive(ts) ? CONFIG.FRENZY.intervalScale : 1);
    }
    for (const [id, it] of round.items) if (it.tEnd <= t) round.items.delete(id);
    if (t >= CONFIG.ROUND_SECONDS) round.over = true;
    return spawned;
  }

  function slash(ax, ay, bx, by, t) {
    if (round.over || t >= CONFIG.ROUND_SECONDS) return [];
    if (Math.hypot(bx - ax, by - ay) < CONFIG.MIN_SLASH) return [];
    const struck = [];
    for (const it of round.items.values()) {
      if (!(it.t0 <= t && t < it.tEnd)) continue;
      if (it.kind === 'boss' && t - bossLastHit < CONFIG.BOSS.cooldown) continue;
      const p = itemPos(it, t);
      if (!segmentHitsCircle(ax, ay, bx, by, p.x, p.y, it.size * CONFIG.HIT_SCALE)) continue;
      struck.push({ it, u: projectOnSegment(ax, ay, bx, by, p.x, p.y) });
    }
    struck.sort((a, b) => a.u - b.u);
    return struck.map(({ it }) => {
      const mult = multiplierAt(t);
      if (it.kind === 'boss') {
        bossLastHit = t;
        round.boss.hits++;
        const points = CONFIG.BOSS.points * mult;
        round.score = Math.max(0, round.score + points);
        const left = CONFIG.BOSS.hits - round.boss.hits;
        if (left <= 0) {
          round.items.delete(it.id);
          round.boss.ko = true;
        }
        return { id: it.id, kind: 'boss', points, score: round.score, mult, t, left: Math.max(0, left) };
      }
      const points = it.kind === 'food' ? CONFIG.POINTS.food * mult : CONFIG.POINTS[it.kind];
      round.items.delete(it.id);
      round.score = Math.max(0, round.score + points);
      round.stats[`${it.kind}s`]++;
      if (it.kind === 'star') frenzyStart = t;
      return { id: it.id, kind: it.kind, points, score: round.score, mult, t };
    });
  }

  return round;
}
