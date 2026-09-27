// Rendering shared by the phone and the laptop. Everything is positioned in
// world units (ARCHITECTURE.md I1) and converted to CSS px through a view, so both
// screens draw the same hit at the same place at their own scale.
import { CONFIG, createRng, itemPos } from './engine.js';

export const COLORS = {
  navy: '#1A2040',
  navy2: '#1E2550',
  plum: '#221848',
  pink: '#F06896',
  lavender: '#B0A8C8',
  gold: '#F0B860',
  green: '#88C8A0',
  red: '#D81C2F',
  cream: '#FFF8F0',
};

export const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
const UI_FONT = 'system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif';

const JUICE = {
  '🍣': ['#F58A6E', '#FFFFFF'],
  '🍙': ['#F4F1EA', '#2E3A2E'],
  '🍡': ['#F29BB8', '#B8E0A8'],
  '🍤': ['#F0B860', '#F58A6E'],
  '🍥': ['#F4F1EA', '#F29BB8'],
  '🍘': ['#D39A55', '#8A5A2A'],
  '🍢': ['#E9B96E', '#F4F1EA'],
  '🍜': ['#F2CF8A', '#F58A6E'],
};

// I1: bottom-anchored, width-or-height fit, horizontally centred.
export function makeView(rx, ry, rw, rh) {
  const s = Math.min(rw / CONFIG.W, rh / CONFIG.H);
  const ox = rx + (rw - s * CONFIG.W) / 2;
  const base = ry + rh;
  return {
    s, ox, base, rx, ry, rw, rh,
    sx: (x) => ox + x * s,
    sy: (y) => base - y * s,
    wx: (px) => (px - ox) / s,
    wy: (py) => (base - py) / s,
  };
}

const sprites = new Map();

// Pre-rendered glyph with its halo. Emoji text rendering is slow and
// inconsistent on phones, so each glyph is drawn once per size.
function sprite(glyph, kind, px) {
  const q = Math.max(16, Math.round(px / 4) * 4);
  const key = `${glyph}|${kind}|${q}`;
  let c = sprites.get(key);
  if (c) return c;
  const side = Math.ceil(q * 1.5);
  c = document.createElement('canvas');
  c.width = c.height = side;
  const g = c.getContext('2d');
  const mid = side / 2;
  const halo = kind === 'bomb' ? 'rgba(216,28,47,' : kind === 'star' || kind === 'boss' ? 'rgba(240,184,96,' : 'rgba(255,248,240,';
  const strength = kind === 'bomb' ? 0.55 : kind === 'star' ? 0.7 : kind === 'boss' ? 0.5 : 0.12;
  const grad = g.createRadialGradient(mid, mid, q * 0.15, mid, mid, side / 2);
  grad.addColorStop(0, halo + strength + ')');
  grad.addColorStop(0.55, halo + strength * 0.45 + ')');
  grad.addColorStop(1, halo + '0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, side, side);
  if (kind === 'bomb') {
    g.strokeStyle = 'rgba(255,120,120,0.55)';
    g.lineWidth = Math.max(1.5, q * 0.035);
    g.beginPath();
    g.arc(mid, mid, q * 0.52, 0, Math.PI * 2);
    g.stroke();
  }
  g.font = `${Math.round(q * 0.86)}px ${EMOJI_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Solid fill: WebKit paints color emoji as a silhouette in a gradient fill.
  g.fillStyle = '#000';
  g.fillText(glyph, mid, mid + q * 0.06);
  sprites.set(key, c);
  return c;
}

function spriteFor(item, view, dpr) {
  return sprite(item.glyph, item.kind, item.size * view.s * dpr);
}

export function drawItem(ctx, view, item, t, dpr) {
  const p = itemPos(item, t);
  const spr = spriteFor(item, view, dpr);
  const d = spr.width / dpr;
  ctx.save();
  ctx.translate(view.sx(p.x), view.sy(p.y));
  ctx.rotate(-p.rot);
  if (item.hitAt) {
    // The boss jolts on every hit.
    const k = Math.max(0, 1 - (performance.now() / 1000 - item.hitAt) / 0.12);
    ctx.scale(1 + 0.1 * k, 1 + 0.1 * k);
  }
  ctx.drawImage(spr, -d / 2, -d / 2, d, d);
  ctx.restore();
}

// Hits-left bar over the bento boss.
export function drawBossBar(ctx, view, item, t, left) {
  const p = itemPos(item, t);
  const w = item.size * view.s * 0.9;
  const h = Math.max(6, 0.02 * view.s);
  const x = view.sx(p.x) - w / 2;
  const y = view.sy(p.y + item.size * 0.66) - h;
  ctx.fillStyle = 'rgba(26,32,64,0.85)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = COLORS.gold;
  ctx.fillRect(x, y, w * (left / CONFIG.BOSS.hits), h);
  ctx.strokeStyle = 'rgba(255,248,240,0.8)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.font = `800 ${Math.round(h * 1.6)}px system-ui,-apple-system,sans-serif`;
  ctx.fillStyle = '#FFF8F0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${left} TO K.O.`, x + w / 2, y - 3);
}

// Tokyo at night: buildings with a few lit windows and Tokyo Tower. Drawn once
// into an offscreen canvas and blitted every frame.
export function renderSkyline(w, h, dpr, { alpha = 1, towerX = 0.48, towerH = 0.33, count = 22 } = {}) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.globalAlpha = alpha;
  const rng = createRng(2024);
  const base = h;

  const glow = g.createLinearGradient(0, base - h * 0.35, 0, base);
  glow.addColorStop(0, 'rgba(240,104,150,0)');
  glow.addColorStop(1, 'rgba(240,104,150,0.07)');
  g.fillStyle = glow;
  g.fillRect(0, base - h * 0.35, w, h * 0.35);

  const tx = w * towerX;
  const th = h * towerH;
  const bw = th * 0.25;
  g.fillStyle = 'rgba(240,104,150,0.08)';
  g.strokeStyle = 'rgba(240,104,150,0.14)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(tx - bw / 2, base);
  g.lineTo(tx - bw * 0.08, base - th);
  g.lineTo(tx + bw * 0.08, base - th);
  g.lineTo(tx + bw / 2, base);
  g.closePath();
  g.fill();
  g.stroke();
  for (const [f, wf] of [[0.55, 0.34], [0.75, 0.2]]) {
    g.fillStyle = 'rgba(240,104,150,0.1)';
    g.fillRect(tx - bw * wf, base - th * f - 3, bw * wf * 2, 6);
  }
  g.beginPath();
  g.moveTo(tx, base - th);
  g.lineTo(tx, base - th * 1.15);
  g.stroke();
  g.fillStyle = 'rgba(240,104,150,0.7)';
  g.beginPath();
  g.arc(tx, base - th * 1.15, 2.5, 0, Math.PI * 2);
  g.fill();

  const windowColors = ['rgba(176,168,200,0.25)', 'rgba(240,104,150,0.2)', 'rgba(240,184,96,0.18)', 'rgba(255,255,255,0.12)'];
  let x = -w * 0.01;
  for (let i = 0; i < count && x < w; i++) {
    const bwid = w * (0.03 + rng() * 0.035);
    const bh = h * (0.08 + rng() * 0.2);
    if (Math.abs(x + bwid / 2 - tx) < bw * 0.7) {
      x += bwid + w * 0.01;
      continue;
    }
    g.fillStyle = 'rgba(18,22,42,0.95)';
    g.fillRect(x, base - bh, bwid, bh);
    const ww = Math.max(2, bwid * 0.15);
    const wh = Math.max(2, bh * 0.04);
    for (let yy = base - bh + wh * 2; yy < base - wh * 2; yy += wh * 3) {
      for (let xx = x + ww; xx < x + bwid - ww; xx += ww * 2) {
        if (rng() < 0.4) {
          g.fillStyle = windowColors[Math.floor(rng() * windowColors.length)];
          g.fillRect(xx, yy, ww, wh);
        }
      }
    }
    if (rng() < 0.2) {
      g.strokeStyle = 'rgba(240,104,150,0.3)';
      g.beginPath();
      g.moveTo(x + bwid / 2, base - bh);
      g.lineTo(x + bwid / 2, base - bh - bh * 0.3);
      g.stroke();
      g.fillStyle = 'rgba(240,104,150,0.55)';
      g.beginPath();
      g.arc(x + bwid / 2, base - bh - bh * 0.3, 2, 0, Math.PI * 2);
      g.fill();
    }
    x += bwid + w * (0.002 + rng() * 0.012);
  }
  return c;
}

// Slash trails, sliced halves, juice, popups, flashes and shake.
// Times here are effect-clock seconds (performance.now() / 1000), not round time,
// so effects keep playing after the round ends.
export class Effects {
  constructor() {
    this.frags = [];
    this.parts = [];
    this.pops = [];
    this.strokes = new Map();
    this.flash = null;
    this.shakeUntil = 0;
  }

  addTrailPoint(stroke, x, y, born) {
    let pts = this.strokes.get(stroke);
    if (!pts) {
      pts = [];
      this.strokes.set(stroke, pts);
    }
    pts.push([x, y, born]);
    if (pts.length > 40) pts.shift();
  }

  // Direction of the newest segment of a stroke, used when a screen only
  // knows the hit and not the finger (the laptop).
  strokeAngle(stroke) {
    const pts = this.strokes.get(stroke);
    if (!pts || pts.length < 2) return 0;
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  }

  hit(item, hit, now, angle) {
    if (item.kind === 'boss' && hit.left > 0) {
      // A hit that the boss survives: a jolt, a spray of crumbs and a +5.
      item.hitAt = now;
      const p = itemPos(item, hit.t);
      const colors = ['#F0B860', '#FFF1C8', '#F06896', '#C8483A', '#FFFFFF'];
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 0.5 * (0.35 + Math.random() * 0.65);
        this.parts.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v + 0.1,
          r: 0.006 + Math.random() * 0.01, color: colors[i % colors.length], born: now, life: 0.35 + Math.random() * 0.3 });
      }
      const ox = (Math.random() - 0.5) * item.size;
      this.pops.push({ text: `+${hit.points}`, color: COLORS.gold, x: p.x + ox, y: p.y + item.size * 0.4, born: now, big: false });
      return;
    }
    const p = itemPos(item, hit.t);
    const vx = item.vx;
    const vy = item.vy - item.g * (hit.t - item.t0);
    if (item.kind !== 'bomb') {
      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      for (const side of [1, -1]) {
        this.frags.push({
          item, x: p.x, y: p.y,
          vx: vx * 0.6 + nx * 0.28 * side,
          vy: Math.max(vy * 0.5, 0) + ny * 0.28 * side + 0.15,
          g: 1.6, rot: p.rot, spin: item.spin + side * 3, angle, side, born: now,
        });
      }
    }
    const colors =
      item.kind === 'bomb' ? ['#FF7A3C', '#D81C2F', '#FFD08A', '#6B6B7A']
      : item.kind === 'star' || item.kind === 'boss' ? ['#F0B860', '#FFF1C8', '#F06896']
      : JUICE[item.glyph] || ['#FFFFFF'];
    const n = item.kind === 'boss' ? 48 : item.kind === 'bomb' ? 22 : item.kind === 'star' ? 18 : 12;
    const speed = item.kind === 'bomb' ? 0.75 : 0.45;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.parts.push({
        x: p.x, y: p.y,
        vx: Math.cos(a) * v + vx * 0.2,
        vy: Math.sin(a) * v + 0.1,
        r: 0.006 + Math.random() * (item.kind === 'bomb' ? 0.016 : 0.01),
        color: colors[i % colors.length],
        born: now,
        life: 0.45 + Math.random() * 0.4,
      });
    }
    const text = item.kind === 'bomb' ? '−30' : item.kind === 'star' ? '×2 FRENZY' : item.kind === 'boss' ? 'K.O.!' : `+${hit.points}`;
    const color = item.kind === 'bomb' ? COLORS.red : item.kind !== 'food' || hit.mult > 1 ? COLORS.gold : COLORS.green;
    this.pops.push({ text, color, x: p.x, y: p.y + 0.06, born: now, big: item.kind !== 'food' });
    if (item.kind === 'bomb') {
      this.flash = { rgb: '216,28,47', a: 0.38, born: now, dur: 0.3 };
      this.shakeUntil = now + 0.28;
    } else if (item.kind === 'star' || item.kind === 'boss') {
      this.flash = { rgb: '240,184,96', a: item.kind === 'boss' ? 0.45 : 0.32, born: now, dur: 0.35 };
      if (item.kind === 'boss') this.shakeUntil = now + 0.28;
    }
  }

  shakeOffset(now, view) {
    if (now >= this.shakeUntil) return [0, 0];
    const k = (this.shakeUntil - now) / 0.28;
    const m = 0.014 * view.s * k;
    return [(Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m];
  }

  drawTrails(ctx, view, now, saber) {
    const life = saber ? 0.35 : 0.2;
    const passes = saber
      ? [[0.062, 'rgba(240,184,96,0.3)'], [0.026, 'rgba(240,200,140,0.6)'], [0.008, 'rgba(255,240,220,0.95)']]
      : [[0.016, 'rgba(240,104,150,0.55)'], [0.006, 'rgba(255,255,255,0.9)']];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [id, pts] of this.strokes) {
      while (pts.length && now - pts[0][2] > life) pts.shift();
      if (pts.length === 0) {
        this.strokes.delete(id);
        continue;
      }
      if (pts.length < 2) continue;
      for (const [width, color] of passes) {
        ctx.strokeStyle = color;
        for (let i = 1; i < pts.length; i++) {
          const k = 1 - (now - pts[i][2]) / life;
          if (k <= 0) continue;
          ctx.lineWidth = Math.max(0.5, width * view.s * k);
          ctx.beginPath();
          ctx.moveTo(view.sx(pts[i - 1][0]), view.sy(pts[i - 1][1]));
          ctx.lineTo(view.sx(pts[i][0]), view.sy(pts[i][1]));
          ctx.stroke();
        }
      }
    }
  }

  drawBehind(ctx, view, now, dpr) {
    this.frags = this.frags.filter((f) => now - f.born < 1.1);
    for (const f of this.frags) {
      const age = now - f.born;
      const x = f.x + f.vx * age;
      const y = f.y + f.vy * age - 0.5 * f.g * age * age;
      const spr = spriteFor(f.item, view, dpr);
      const d = spr.width / dpr;
      ctx.save();
      ctx.globalAlpha = Math.min(1, Math.max(0, 1 - (age - 0.6) / 0.5));
      ctx.translate(view.sx(x), view.sy(y));
      ctx.rotate(-f.angle - f.side * age * 1.2);
      ctx.beginPath();
      if (f.side > 0) ctx.rect(-d, -d, 2 * d, d);
      else ctx.rect(-d, 0, 2 * d, d);
      ctx.clip();
      ctx.rotate(f.angle - (f.rot + f.spin * age * 0.2));
      ctx.drawImage(spr, -d / 2, -d / 2, d, d);
      ctx.restore();
    }
  }

  drawFront(ctx, view, now) {
    this.parts = this.parts.filter((p) => now - p.born < p.life);
    for (const p of this.parts) {
      const age = now - p.born;
      const x = p.x + p.vx * age;
      const y = p.y + p.vy * age - 0.9 * age * age;
      ctx.globalAlpha = Math.max(0, 1 - age / p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(view.sx(x), view.sy(y), Math.max(1, p.r * view.s * (1 - age / p.life * 0.5)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    this.pops = this.pops.filter((p) => now - p.born < 0.75);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.pops) {
      const age = now - p.born;
      const pop = age < 0.08 ? 0.7 + (age / 0.08) * 0.5 : 1.2 - Math.min(0.2, (age - 0.08) * 0.8);
      const size = (p.big ? 0.085 : 0.07) * view.s * pop;
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, age - 0.4) / 0.35);
      ctx.font = `900 ${Math.round(size)}px ${UI_FONT}`;
      const x = view.sx(p.x);
      const y = view.sy(p.y + age * 0.2);
      ctx.lineWidth = Math.max(2, size * 0.14);
      ctx.strokeStyle = 'rgba(15,16,40,0.85)';
      ctx.strokeText(p.text, x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, x, y);
    }
    ctx.globalAlpha = 1;
  }

  drawFlash(ctx, x, y, w, h, now) {
    if (!this.flash) return;
    const age = now - this.flash.born;
    if (age > this.flash.dur) {
      this.flash = null;
      return;
    }
    ctx.fillStyle = `rgba(${this.flash.rgb},${this.flash.a * (1 - age / this.flash.dur)})`;
    ctx.fillRect(x, y, w, h);
  }
}
