// Phone controller. The phone is authoritative (ARCHITECTURE.md): it runs the round,
// detects slashes, and tells the server what spawned and what got cut.
import { CONFIG, createRound, itemPos } from './shared/engine.js';
import { makeView, drawItem, drawBossBar, Effects, renderSkyline, COLORS } from './shared/draw.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const nameInput = $('name');
const playBtn = $('play');
const statusEl = $('status');

const PHASE_BANNERS = {
  warmup: ['準備 WARM-UP', 'Food only. Get a feel for it.', COLORS.green],
  main: ['本番 THE REAL GAME', 'Bombs incoming.', COLORS.pink],
  chaos: ['混沌 CHAOS', 'Almost half are bombs. Pick your cuts.', '#FF5A6A'],
};

let ws = null;
let reconnectTimer = null;
let boothStatus = 'connecting';
let mode = 'join'; // join | count | play | over | lost
let starting = false;

let round = null;
let seed = 0;
let beginAt = 0;
let spawned = new Map();
let effects = new Effects();
let lastPhase = null;
let frenzyUntil = -1;
let resultTimer = null;

let W = 0;
let H = 0;
let dpr = 1;
let view = makeView(0, 0, 1, 1.75);
let skyline = null;

let strokeId = 0;
const pointers = new Map();
const trailBuf = new Map();
let lastTrailFlush = 0;
let wakeLock = null;

nameInput.value = localStorage.getItem('kiru-name') || '';

// ---------- screens ----------

function show(id) {
  mode = id;
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id);
  $('hud').classList.toggle('on', id === 'play');
  $('panic').classList.remove('on');
}

function renderStatus() {
  if (mode !== 'join') return;
  const text = {
    connecting: 'Connecting…',
    offline: "Can't reach the booth. Retrying…",
    ready: starting ? 'Starting…' : '',
    wait: "Someone's mid-round. You're next, hang tight.",
  }[boothStatus];
  statusEl.textContent = text;
  statusEl.classList.toggle('warn', boothStatus === 'wait' || boothStatus === 'offline');
  playBtn.disabled = boothStatus !== 'ready' || starting;
}

// ---------- network ----------

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  sock.onopen = () => send({ type: 'hello', role: 'player', name: nameInput.value });
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
    starting = false;
    if (mode === 'play' || mode === 'count') lose("Connection dropped. This round won't count.");
    if (mode === 'over' && resultTimer) showResultError("Lost the booth connection. Your score wasn't saved.");
    boothStatus = 'offline';
    renderStatus();
    reconnectTimer = setTimeout(connect, 1000);
  };
}

function onMessage(msg) {
  if (msg.type === 'welcome') {
    boothStatus = msg.status === 'ready' ? 'ready' : 'wait';
    if (boothStatus === 'wait') starting = false;
    if (mode === 'over' && starting) show('join');
    renderStatus();
  } else if (msg.type === 'go') {
    starting = false;
    countdown();
  } else if (msg.type === 'result') {
    clearTimeout(resultTimer);
    resultTimer = null;
    $('rank').textContent = msg.rank === 1 ? `#1 of ${msg.total}. Top of the board! 🏆` : `#${msg.rank} of ${msg.total}`;
    $('stats').textContent = `${$('stats').textContent}  ·  Top score: ${msg.best}`;
  } else if (msg.type === 'error') {
    showResultError("Couldn't save that one. Play again?");
  }
}

function showResultError(text) {
  clearTimeout(resultTimer);
  resultTimer = null;
  $('rank').textContent = text;
}

function requestStart() {
  const name = nameInput.value.trim();
  localStorage.setItem('kiru-name', name);
  nameInput.blur();
  starting = true;
  seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
  send({ type: 'hello', role: 'player', name });
  send({ type: 'start', seed });
  keepAwake();
  renderStatus();
}

async function keepAwake() {
  try {
    if (!wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    wakeLock = null;
  }
}

// ---------- round flow ----------

function countdown() {
  show('count');
  const el = $('countN');
  const steps = ['3', '2', '1', '斬!'];
  let i = 0;
  const tick = () => {
    if (mode !== 'count') return;
    if (i === steps.length) return begin();
    const n = el.cloneNode(false);
    n.textContent = steps[i];
    el.replaceWith(n);
    n.id = 'countN';
    i++;
    setTimeout(tick, i === steps.length ? 450 : 700);
  };
  tick();
}

function begin() {
  round = createRound(seed);
  spawned = new Map();
  effects = new Effects();
  pointers.clear();
  trailBuf.clear();
  lastPhase = null;
  frenzyUntil = -1;
  beginAt = performance.now();
  send({ type: 'begin' });
  show('play');
  $('score').textContent = '0';
}

function roundTime(nowMs = performance.now()) {
  return (nowMs - beginAt) / 1000;
}

function finish() {
  flushTrail(true);
  const { score, stats } = round;
  send({ type: 'end', score, stats });
  show('over');
  pointers.clear();
  $('final').textContent = String(score);
  $('rank').textContent = 'Saving your score…';
  const bombs = stats.bombs === 1 ? '1 bomb' : `${stats.bombs} bombs`;
  const boss = round.boss.ko ? ' · 🍱 K.O.!' : round.boss.hits ? ` · 🍱 ${round.boss.hits} hits` : '';
  $('stats').textContent = `${stats.foods} sliced · ${bombs}${stats.stars ? ' · star caught' : ''}${boss}`;
  resultTimer = setTimeout(() => showResultError("Couldn't reach the booth. Your score wasn't saved."), 6000);
}

function lose(text) {
  if (mode === 'play' || mode === 'count') send({ type: 'quit' });
  round = null;
  pointers.clear();
  $('lostMsg').textContent = text;
  show('lost');
}

function banner(title, sub, color) {
  const b = $('banner');
  const n = b.cloneNode(false);
  n.innerHTML = '';
  n.append(title);
  const s = document.createElement('small');
  s.textContent = sub;
  n.append(s);
  n.style.color = color;
  n.className = 'banner show';
  b.replaceWith(n);
}

function updateHud(t) {
  const left = Math.max(0, CONFIG.ROUND_SECONDS - t);
  $('time').textContent = String(Math.ceil(left));
  $('time').classList.toggle('panic', left <= 3);
  $('panic').classList.toggle('on', left <= 3 && left > 0);
  $('bar').style.transform = `scaleX(${left / CONFIG.ROUND_SECONDS})`;
  $('mult').classList.toggle('on', round.frenzyActive(t));
  const phase = round.phaseAt(t);
  if (phase !== lastPhase) {
    lastPhase = phase;
    banner(...PHASE_BANNERS[phase]);
  }
}

// ---------- input ----------

function addPoint(stroke, x, y, t, now) {
  effects.addTrailPoint(stroke, x, y, now);
  let buf = trailBuf.get(stroke);
  if (!buf) trailBuf.set(stroke, (buf = []));
  buf.push([+x.toFixed(4), +y.toFixed(4), +t.toFixed(3)]);
}

function flushTrail(force) {
  const now = performance.now();
  if (!force && now - lastTrailFlush < 50) return;
  lastTrailFlush = now;
  for (const [stroke, pts] of trailBuf) if (pts.length) send({ type: 'trail', stroke, pts });
  trailBuf.clear();
}

function cut(p, x, y, nowMs) {
  const t = roundTime(nowMs);
  const now = nowMs / 1000;
  addPoint(p.stroke, x, y, t, now);
  if (Math.hypot(x - p.x, y - p.y) < CONFIG.MIN_SLASH) return;
  const hits = round.slash(p.x, p.y, x, y, t);
  if (hits.length) {
    const angle = Math.atan2(y - p.y, x - p.x);
    for (const h of hits) {
      effects.hit(spawned.get(h.id), h, now, angle);
      if (h.kind === 'star') {
        frenzyUntil = h.t + CONFIG.FRENZY.seconds;
        banner('⭐ FRENZY ×2', 'No new bombs. Go wild.', COLORS.gold);
      } else if (h.kind === 'boss' && h.left === 0) {
        banner('K.O.!', 'Bento boss down.', COLORS.gold);
      }
    }
    send({ type: 'slice', hits });
    $('score').textContent = String(round.score);
  }
  p.x = x;
  p.y = y;
}

canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'play') return;
  e.preventDefault();
  canvas.setPointerCapture?.(e.pointerId);
  const x = view.wx(e.clientX);
  const y = view.wy(e.clientY);
  const p = { stroke: ++strokeId, x, y };
  pointers.set(e.pointerId, p);
  addPoint(p.stroke, x, y, roundTime(), performance.now() / 1000);
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p || mode !== 'play') return;
  e.preventDefault();
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  const nowMs = performance.now();
  for (const ev of events.length ? events : [e]) cut(p, view.wx(ev.clientX), view.wy(ev.clientY), nowMs);
});

for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(type, (e) => pointers.delete(e.pointerId));
}

document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

document.addEventListener('visibilitychange', () => {
  if (document.hidden && (mode === 'play' || mode === 'count')) {
    lose('You left the page, so this round was cancelled.');
  } else if (!document.hidden && wakeLock === null && mode !== 'join') {
    keepAwake();
  }
});

playBtn.addEventListener('click', () => {
  if (!playBtn.disabled) requestStart();
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !playBtn.disabled) requestStart();
});
$('again').addEventListener('click', () => {
  show('join');
  if (boothStatus === 'ready' || boothStatus === 'wait') requestStart();
  else renderStatus();
});
$('retry').addEventListener('click', () => {
  show('join');
  if (!ws) connect();
  else send({ type: 'hello', role: 'player', name: nameInput.value });
  renderStatus();
});

// ---------- render ----------

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  view = makeView(0, 0, W, H);
  skyline = renderSkyline(W, H, dpr, { alpha: 0.55, towerX: 0.72, towerH: 0.26, count: 14 });
}

function frame(nowMs) {
  const now = nowMs / 1000;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (skyline) ctx.drawImage(skyline, 0, 0, W, H);

  let t = 0;
  if (mode === 'play' && round) {
    t = roundTime(nowMs);
    for (const item of round.update(Math.min(t, CONFIG.ROUND_SECONDS))) {
      spawned.set(item.id, item);
      send({ type: 'spawn', item });
      if (item.kind === 'boss') banner('🍱 BENTO BOSS', 'Slash it fast. 50 hits to knock it out.', COLORS.gold);
    }
    updateHud(t);
    if (t >= CONFIG.ROUND_SECONDS) finish();
  }

  const [dx, dy] = effects.shakeOffset(now, view);
  ctx.translate(dx, dy);
  effects.drawBehind(ctx, view, now, dpr);
  if (mode === 'play' && round) {
    for (const item of round.items.values()) if (item.t0 <= t) drawItem(ctx, view, item, t, dpr);
    for (const item of round.items.values()) {
      if (item.kind === 'boss' && item.t0 <= t) drawBossBar(ctx, view, item, t, CONFIG.BOSS.hits - round.boss.hits);
    }
  }
  effects.drawTrails(ctx, view, now, t < frenzyUntil);
  effects.drawFront(ctx, view, now);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  effects.drawFlash(ctx, 0, 0, W, H, now);

  if (mode === 'play') flushTrail(false);
  requestAnimationFrame(frame);
}

// Read-only hook for the automated end-to-end test: where the live items are on screen.
window.kiruTest = {
  get mode() {
    return mode;
  },
  get bossHits() {
    return round ? round.boss.hits : 0;
  },
  targets() {
    if (!round) return [];
    const t = roundTime();
    return [...round.items.values()]
      .filter((it) => it.t0 <= t && t < it.tEnd)
      .map((it) => {
        const p = itemPos(it, t);
        return { id: it.id, kind: it.kind, x: view.sx(p.x), y: view.sy(p.y), r: it.size * CONFIG.HIT_SCALE * view.s };
      });
  },
};

window.addEventListener('resize', resize);
resize();
renderStatus();
connect();
requestAnimationFrame(frame);
