// Laptop crowd screen. It never spawns anything during a real round: it redraws
// what the phone reports, with the same closed-form motion (ARCHITECTURE.md I3).
import { CONFIG, createRng, createRound, itemPos, segmentHitsCircle } from './shared/engine.js';
import { makeView, drawItem, drawBossBar, Effects, renderSkyline, COLORS } from './shared/draw.js';
import { Sound } from './audio.js';

const $ = (id) => document.getElementById(id);
const arena = $('arena');
const ctx = arena.getContext('2d');
const skyCanvas = $('sky');
const sound = new Sound();

const PHASE_BANNERS = {
  warmup: ['準備 WARM-UP', 'Food only', COLORS.green],
  main: ['本番 THE REAL GAME', 'Bombs incoming', COLORS.pink],
  chaos: ['混沌 CHAOS', 'Almost half are bombs', '#FF5A6A'],
};

let ws = null;
let state = 'idle'; // idle | count | live | result | cancel
let live = null;
let overlayTimer = null;
let leaderboard = [];
let freshKey = null;
let effects = new Effects();
let demo = null;

let W = 0;
let H = 0;
let dpr = 1;
let view = makeView(0, 0, 1, 1.75);

// ---------- overlays ----------

function overlay(id) {
  for (const o of document.querySelectorAll('.overlay')) o.classList.toggle('on', o.id === id);
}

function setState(next) {
  state = next;
  clearTimeout(overlayTimer);
  $('hud').classList.toggle('on', next === 'live');
  $('panic').classList.remove('on');
  document.body.classList.remove('frenzy');
  if (next === 'idle') {
    overlay('idle');
    sound.setMusic('idle');
    live = null;
  } else if (next === 'count') {
    overlay('count');
  } else if (next === 'live') {
    overlay(null);
  }
}

function banner(title, sub, color) {
  const b = $('banner');
  const n = b.cloneNode(false);
  n.append(title);
  const s = document.createElement('small');
  s.textContent = sub;
  n.append(s);
  n.style.color = color;
  n.className = 'show';
  b.replaceWith(n);
}

// ---------- leaderboard and lobby ----------

function renderBoard(total) {
  const ol = $('board');
  ol.replaceChildren();
  if (leaderboard.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nobody yet. Be the first on the board.';
    ol.append(li);
  }
  leaderboard.forEach((e, i) => {
    const li = document.createElement('li');
    const r = document.createElement('span');
    r.className = 'r';
    r.textContent = i === 0 ? '👑' : String(i + 1);
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = e.name;
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = String(e.score);
    li.append(r, n, s);
    if (freshKey && e.ts === freshKey) li.classList.add('fresh');
    ol.append(li);
  });
  if (typeof total === 'number') $('boardSub').textContent = total === 1 ? '1 round played' : `${total} rounds played`;
}

function setPlayUrl(url) {
  $('qr').src = `/qr.svg?u=${encodeURIComponent(url)}`;
  $('url').textContent = url.replace(/^https?:\/\//, '');
  const pub = url.startsWith('https://');
  $('net').textContent = pub ? 'Works on any network, cellular too' : 'Phones: join the same Wi-Fi as this laptop';
  $('net').classList.toggle('warn', !pub);
}

async function refreshTotal() {
  try {
    const lb = await (await fetch('/api/leaderboard')).json();
    leaderboard = lb.top;
    renderBoard(lb.total);
  } catch {
    // the lobby message carries the board too; the count just stays stale
  }
}

// ---------- network ----------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  sock.onopen = () => {
    sock.send(JSON.stringify({ type: 'hello', role: 'host' }));
    $('status').classList.remove('down');
    $('statusText').textContent = 'live';
  };
  sock.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    onMessage(msg);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    $('status').classList.add('down');
    $('statusText').textContent = 'server not reachable, retrying…';
    if (state !== 'idle') setState('idle');
    setTimeout(connect, 1000);
  };
}

function onMessage(msg) {
  switch (msg.type) {
    case 'lobby':
      setPlayUrl(msg.playUrl);
      leaderboard = msg.leaderboard;
      renderBoard();
      refreshTotal();
      if (msg.playing && state === 'idle') showCancel(`${msg.playing.name} is playing…`, 0);
      break;
    case 'start':
      startCountdown(msg.name);
      break;
    case 'begin':
      beginRound();
      break;
    case 'spawn':
      if (live) live.items.set(msg.item.id, msg.item);
      if (live && msg.item.kind === 'boss') {
        banner('🍱 BENTO BOSS', 'Slash it fast. 50 hits to knock it out.', COLORS.gold);
        sound.star();
      }
      break;
    case 'trail':
      onTrail(msg);
      break;
    case 'slice':
      onSlice(msg.hits);
      break;
    case 'end':
      onEnd(msg);
      break;
    case 'abandon':
      sound.cancel();
      showCancel(`${msg.name}'s round was cancelled`, 2500);
      break;
  }
}

// ---------- round ----------

function startCountdown(name) {
  live = { name, items: new Map(), bossLeft: CONFIG.BOSS.hits, beginAt: 0, score: 0, frenzyUntil: -1, lastPhase: null, lastStroke: 0, lastTick: -1 };
  effects = new Effects();
  setState('count');
  sound.setMusic('off');
  $('countWho').textContent = `${name} is up!`;
  const steps = ['3', '2', '1', '斬!'];
  let i = 0;
  const tick = () => {
    if (state !== 'count' || i === steps.length) return;
    const el = $('countN');
    const n = el.cloneNode(false);
    n.textContent = steps[i];
    el.replaceWith(n);
    sound.countdown(i === steps.length - 1);
    i++;
    overlayTimer = setTimeout(tick, 700);
  };
  tick();
}

function beginRound() {
  if (!live) return;
  live.beginAt = performance.now();
  $('who').textContent = live.name;
  $('score').textContent = '0';
  setState('live');
  sound.setMusic('warmup');
}

function roundTime() {
  return (performance.now() - live.beginAt) / 1000;
}

function onTrail(msg) {
  if (!live || state !== 'live' || !msg.pts.length) return;
  const now = performance.now() / 1000;
  const lastT = msg.pts[msg.pts.length - 1][2];
  for (const [x, y, t] of msg.pts) effects.addTrailPoint(msg.stroke, x, y, now - Math.max(0, lastT - t));
  live.lastStroke = msg.stroke;
}

function onSlice(hits) {
  if (!live) return;
  const now = performance.now() / 1000;
  const angle = effects.strokeAngle(live.lastStroke);
  for (const h of hits) {
    const item = live.items.get(h.id);
    if (h.kind === 'boss') live.bossLeft = h.left;
    if (h.kind !== 'boss' || h.left === 0) live.items.delete(h.id);
    live.score = h.score;
    if (!item) continue;
    effects.hit(item, h, now, angle);
    if (h.kind === 'bomb') sound.bomb();
    else if (h.kind === 'boss') {
      if (h.left === 0) {
        sound.star();
        banner('K.O.!', 'Bento boss down.', COLORS.gold);
      } else sound.slice(1);
    }
    else if (h.kind === 'star') {
      sound.star();
      live.frenzyUntil = h.t + CONFIG.FRENZY.seconds;
      banner('⭐ FRENZY ×2', 'No new bombs. Food doubles.', COLORS.gold);
    } else sound.slice(h.mult);
  }
  const el = $('score');
  el.textContent = String(live.score);
  el.animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 160, easing: 'ease-out' });
}

function onEnd(msg) {
  leaderboard = msg.leaderboard;
  const mine = msg.leaderboard.find((e) => e.name === msg.name && e.score === msg.score);
  freshKey = mine ? mine.ts : null;
  renderBoard();
  refreshTotal();
  setState('result');
  sound.setMusic('off');
  overlay('result');
  $('resName').textContent = msg.name;
  $('resScore').textContent = String(msg.score);
  $('resRank').textContent = `#${msg.rank} on the board`;
  const top = msg.rank === 1 && msg.score > 0;
  $('resTop').textContent = top ? '🏆 NEW TOP SCORE' : '';
  sound.gong(top);
  overlayTimer = setTimeout(() => setState('idle'), 6500);
}

function showCancel(text, ms) {
  setState('cancel');
  overlay('cancel');
  $('cancelMsg').textContent = text;
  sound.setMusic('idle');
  if (ms) overlayTimer = setTimeout(() => setState('idle'), ms);
}

function updateLive(t) {
  const left = Math.max(0, CONFIG.ROUND_SECONDS - t);
  $('time').textContent = String(Math.ceil(left));
  $('time').classList.toggle('panic', left <= 3);
  $('panic').classList.toggle('on', left <= 3 && left > 0);
  if (left <= 3 && left > 0 && Math.ceil(left) !== live.lastTick) {
    live.lastTick = Math.ceil(left);
    sound.tick();
  }
  const frenzy = t < live.frenzyUntil;
  $('mult').classList.toggle('on', frenzy);
  document.body.classList.toggle('frenzy', frenzy);
  const p = CONFIG.PHASES.find((ph) => t >= ph.start && t < ph.end)?.name ?? 'chaos';
  if (p !== live.lastPhase) {
    live.lastPhase = p;
    banner(...PHASE_BANNERS[p]);
    sound.phase(p);
  }
  if (left > 0) sound.setMusic(frenzy ? 'frenzy' : p);
  else sound.setMusic('off');
  for (const [id, it] of live.items) if (it.tEnd <= t) live.items.delete(id);
}

// ---------- attract demo ----------

// A ghost round played by a simple bot while nobody is playing, so the
// laptop is never a still image.
function demoFrame(now) {
  if (!demo || now - demo.start > CONFIG.ROUND_SECONDS + 1.5) {
    const seed = (Math.random() * 2 ** 31) | 0;
    demo = { round: createRound(seed), rng: createRng(seed), start: now, last: 0, stroke: 1e6, frenzyUntil: -1 };
  }
  const t = Math.min(now - demo.start, CONFIG.ROUND_SECONDS);
  const r = demo.round;
  r.update(t);
  if (t - demo.last > 0.38 && t < CONFIG.ROUND_SECONDS) {
    const liveItems = [...r.items.values()].filter((it) => it.t0 <= t && t < it.tEnd);
    const bombs = liveItems.filter((it) => it.kind === 'bomb').map((it) => [it, itemPos(it, t)]);
    const target = liveItems
      .filter((it) => it.kind !== 'bomb')
      .map((it) => [it, itemPos(it, t)])
      .find(([, p]) => p.y > 0.35 && p.y < 1.45);
    if (target) {
      const [, p] = target;
      const a = (demo.rng() - 0.5) * 1.6;
      const dx = Math.cos(a) * 0.16;
      const dy = Math.sin(a) * 0.16;
      const seg = [p.x - dx, p.y - dy, p.x + dx, p.y + dy];
      const safe = !bombs.some(([b, bp]) => segmentHitsCircle(...seg, bp.x, bp.y, b.size * CONFIG.HIT_SCALE + 0.02));
      if (safe) {
        const stroke = ++demo.stroke;
        for (let i = 0; i <= 6; i++) effects.addTrailPoint(stroke, seg[0] + (seg[2] - seg[0]) * (i / 6), seg[1] + (seg[3] - seg[1]) * (i / 6), now - (6 - i) * 0.012);
        const byId = new Map(liveItems.map((it) => [it.id, it]));
        for (const h of r.slash(...seg, t)) {
          effects.hit(byId.get(h.id), h, now, Math.atan2(dy, dx));
          if (h.kind === 'star') demo.frenzyUntil = h.t + CONFIG.FRENZY.seconds;
        }
        demo.last = t;
      }
    }
  }
  return t;
}

// ---------- render ----------

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = arena.getBoundingClientRect();
  W = rect.width;
  H = rect.height;
  arena.width = Math.round(W * dpr);
  arena.height = Math.round(H * dpr);
  const pad = Math.max(12, H * 0.02);
  view = makeView(pad, pad, W - pad * 2, H - pad * 2);
  const sw = window.innerWidth;
  const sh = window.innerHeight;
  skyCanvas.width = Math.round(sw * dpr);
  skyCanvas.height = Math.round(sh * dpr);
  const sky = renderSkyline(sw, sh, dpr, { alpha: 1, towerX: 0.5, towerH: 0.34, count: 36 });
  const sctx = skyCanvas.getContext('2d');
  sctx.drawImage(sky, 0, 0);
}

function drawStage(now, frenzy) {
  const x = view.ox;
  const y = view.sy(CONFIG.H);
  const w = view.s * CONFIG.W;
  const h = view.s * CONFIG.H;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 18);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, frenzy ? 'rgba(60,40,90,0.55)' : 'rgba(14,16,38,0.45)');
  g.addColorStop(1, frenzy ? 'rgba(90,60,40,0.35)' : 'rgba(34,24,72,0.45)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = frenzy ? 'rgba(240,184,96,0.6)' : 'rgba(176,168,200,0.18)';
  ctx.stroke();
  if (frenzy) {
    for (let i = 0; i < 40; i++) {
      const sx = x + ((i * 97) % 100) / 100 * w;
      const sy = y + ((i * 53) % 70) / 100 * h;
      ctx.fillStyle = `rgba(255,240,200,${0.15 + 0.4 * Math.abs(Math.sin(now * (1 + (i % 3)) + i))})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 1 + (i % 3) * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  return [x, y, w, h];
}

function frame(nowMs) {
  const now = nowMs / 1000;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  let t = 0;
  let items = [];
  let frenzy = false;
  let alpha = 1;
  if (state === 'live' && live) {
    t = roundTime();
    updateLive(t);
    frenzy = t < live.frenzyUntil;
    items = [...live.items.values()];
  } else if (state === 'idle') {
    t = demoFrame(now);
    frenzy = t < demo.frenzyUntil;
    items = [...demo.round.items.values()];
    alpha = 0.6;
  }

  const [sx, sy, sw, sh] = drawStage(now, frenzy);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(sx, sy, sw, sh, 18);
  ctx.clip();
  const [dx, dy] = effects.shakeOffset(now, view);
  ctx.translate(dx, dy);
  ctx.globalAlpha = alpha;
  effects.drawBehind(ctx, view, now, dpr);
  for (const it of items) if (it.t0 <= t && t < it.tEnd) drawItem(ctx, view, it, t, dpr);
  for (const it of items) {
    if (it.kind !== 'boss' || !(it.t0 <= t && t < it.tEnd)) continue;
    drawBossBar(ctx, view, it, t, state === 'live' && live ? live.bossLeft : CONFIG.BOSS.hits - demo.round.boss.hits);
  }
  effects.drawTrails(ctx, view, now, frenzy);
  effects.drawFront(ctx, view, now);
  ctx.globalAlpha = 1;
  ctx.restore();
  effects.drawFlash(ctx, sx, sy, sw, sh, now);

  requestAnimationFrame(frame);
}

// ---------- operator controls ----------

async function openBooth() {
  await sound.unlock();
  sound.setMusic(state === 'idle' ? 'idle' : 'off');
  $('gate').classList.add('off');
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
}

$('gate').addEventListener('click', openBooth);
document.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') {
    const on = sound.toggleMusic();
    $('keys').textContent = on ? 'M music · F fullscreen' : 'M music (muted) · F fullscreen';
  } else if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
});

// Read-only hook for the automated end-to-end test.
window.kiruHost = {
  get state() {
    return state;
  },
  get liveItems() {
    return live ? live.items.size : 0;
  },
  get score() {
    return live ? live.score : null;
  },
  get audio() {
    return sound.ready;
  },
  board: () => leaderboard.map((e) => ({ name: e.name, score: e.score })),
};

window.addEventListener('resize', resize);
resize();
renderBoard();
connect();
requestAnimationFrame(frame);
