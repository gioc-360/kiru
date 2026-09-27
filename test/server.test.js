// Acceptance contract for the relay server + leaderboard persistence.
// Written before the server existed. Do not edit to make
// the build pass: if an assertion is wrong, fix the spec first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server.js';

let publicDir;
const dataDirs = [];

before(() => {
  publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiru-public-'));
  fs.writeFileSync(path.join(publicDir, 'host.html'), '<!doctype html><title>host-fixture</title>');
  fs.writeFileSync(path.join(publicDir, 'play.html'), '<!doctype html><title>play-fixture</title>');
  fs.mkdirSync(path.join(publicDir, 'shared'));
  fs.writeFileSync(path.join(publicDir, 'shared', 'x.js'), 'export const x = 1;');
});

after(() => {
  fs.rmSync(publicDir, { recursive: true, force: true });
  for (const d of dataDirs) fs.rmSync(d, { recursive: true, force: true });
});

function freshDataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kiru-data-'));
  dataDirs.push(d);
  return d;
}

async function boot(opts = {}) {
  const dataDir = opts.dataDir ?? freshDataDir();
  const srv = await startServer({ port: 0, dataDir, publicDir, tunnel: false, log: false, minRoundMs: 0, ...opts });
  return { ...srv, dataDir, base: `http://127.0.0.1:${srv.port}` };
}

// A WebSocket client with an inbox, so tests can await a message by type.
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const opened = new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  return {
    ws,
    opened,
    send: (m) => ws.send(JSON.stringify(m)),
    next(type, ms = 2000) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { type, resolve };
        waiters.push(w);
        setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) {
            waiters.splice(j, 1);
            reject(new Error(`timed out waiting for "${type}"; inbox: ${JSON.stringify(inbox)}`));
          }
        }, ms);
      });
    },
    has: (type) => inbox.some((m) => m.type === type),
    close: () => ws.close(),
  };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function host(port) {
  const h = client(port);
  await h.opened;
  h.send({ type: 'hello', role: 'host' });
  const lobby = await h.next('lobby');
  return { h, lobby };
}

async function player(port, name) {
  const p = client(port);
  await p.opened;
  p.send({ type: 'hello', role: 'player', name });
  const welcome = await p.next('welcome');
  return { p, welcome };
}

test('HTTP routes: host page, play page, static files, traversal blocked', async () => {
  const s = await boot();
  try {
    const root = await fetch(`${s.base}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /text\/html/);
    assert.match(await root.text(), /host-fixture/);
    const play = await fetch(`${s.base}/play`);
    assert.equal(play.status, 200);
    assert.match(await play.text(), /play-fixture/);
    const js = await fetch(`${s.base}/shared/x.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${s.base}/nope.html`)).status, 404);
    assert.equal((await fetch(`${s.base}/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
  } finally {
    await s.close();
  }
});

test('API: info, leaderboard, QR code', async () => {
  const s = await boot();
  try {
    const info = await (await fetch(`${s.base}/api/info`)).json();
    assert.match(info.playUrl, /^https?:\/\/.+\/play$/);
    assert.equal(info.publicUrl, null);
    const lb = await (await fetch(`${s.base}/api/leaderboard`)).json();
    assert.deepEqual(lb, { top: [], total: 0 });
    const qr = await fetch(`${s.base}/qr.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await qr.text(), /<svg/);
  } finally {
    await s.close();
  }
});

test('a full round: claim, relay, end, result, leaderboard, persistence across restart', async () => {
  const dataDir = freshDataDir();
  let s = await boot({ dataDir });
  const { h, lobby } = await host(s.port);
  assert.deepEqual(lobby.leaderboard, []);
  assert.equal(lobby.playing, null);
  assert.match(lobby.playUrl, /\/play$/);

  const { p, welcome } = await player(s.port, '  Aiko  ');
  assert.equal(welcome.status, 'ready');
  p.send({ type: 'start', seed: 123 });
  await p.next('go');
  assert.deepEqual(await h.next('start'), { type: 'start', name: 'Aiko', seed: 123 });

  const { p: p2, welcome: w2 } = await player(s.port, 'Ben');
  assert.equal(w2.status, 'wait', 'a second phone waits while someone plays');
  p2.send({ type: 'start', seed: 5 });
  assert.equal((await p2.next('welcome')).status, 'wait');
  p2.send({ type: 'spawn', item: { id: 999 } });

  p.send({ type: 'begin' });
  assert.deepEqual(await h.next('begin'), { type: 'begin' });
  const item = { id: 1, kind: 'food', glyph: '🍣', t0: 0.6, x0: 0.4, y0: -0.26, vx: 0.03, vy: 1.5, g: 0.875, spin: 1.2, rot0: 0.3, size: 0.13, tEnd: 4.1 };
  p.send({ type: 'spawn', item });
  assert.deepEqual(await h.next('spawn'), { type: 'spawn', item }, 'spawn relayed verbatim');
  const slice = { type: 'slice', hits: [{ id: 1, kind: 'food', points: 10, score: 10, mult: 1, t: 1.5 }] };
  p.send(slice);
  assert.deepEqual(await h.next('slice'), slice);
  const trail = { type: 'trail', stroke: 1, pts: [[0.1, 0.5, 1.4], [0.2, 0.52, 1.43]] };
  p.send(trail);
  assert.deepEqual(await h.next('trail'), trail);
  await settle();
  assert.equal(h.has('spawn'), false, 'relay from a waiting phone is ignored');

  p.send({ type: 'end', score: 120, stats: { foods: 12, bombs: 0, stars: 0 } });
  assert.deepEqual(await p.next('result'), { type: 'result', score: 120, rank: 1, total: 1, best: 120 });
  const end = await h.next('end');
  assert.equal(end.name, 'Aiko');
  assert.equal(end.score, 120);
  assert.equal(end.rank, 1);
  assert.equal(end.leaderboard.length, 1);
  assert.equal(end.leaderboard[0].name, 'Aiko');
  assert.equal(end.leaderboard[0].score, 120);
  assert.match(end.leaderboard[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await p2.next('welcome')).status, 'ready', 'waiting phone is told the booth is free');

  const lb = await (await fetch(`${s.base}/api/leaderboard`)).json();
  assert.equal(lb.total, 1);
  assert.equal(lb.top[0].name, 'Aiko');

  h.close();
  p.close();
  p2.close();
  await s.close();

  s = await boot({ dataDir });
  try {
    const lb2 = await (await fetch(`${s.base}/api/leaderboard`)).json();
    assert.equal(lb2.total, 1, 'scores survive a server restart');
    assert.equal(lb2.top[0].score, 120);
    const events = fs
      .readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const kinds = events.map((e) => e.event);
    for (const k of ['join', 'start', 'begin', 'end']) assert.ok(kinds.includes(k), `events.jsonl has ${k}`);
    const endEv = events.find((e) => e.event === 'end');
    assert.equal(endEv.name, 'Aiko');
    assert.equal(endEv.score, 120);
    assert.match(endEv.ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await s.close();
  }
});

test('ranking: rank counts strictly higher scores; top is sorted and capped at 10', async () => {
  const s = await boot();
  try {
    const { h } = await host(s.port);
    const scores = [50, 300, 120, 300, 10, 80, 90, 100, 110, 130, 140, 150];
    let last;
    for (const [i, score] of scores.entries()) {
      const { p } = await player(s.port, `P${i}`);
      p.send({ type: 'start', seed: i });
      await p.next('go');
      p.send({ type: 'begin' });
      p.send({ type: 'end', score, stats: {} });
      last = await p.next('result');
      await h.next('end');
      p.close();
      await settle(30);
    }
    assert.equal(last.rank, 3, '150 ranks behind two 300s');
    assert.equal(last.total, 12);
    assert.equal(last.best, 300);
    const lb = await (await fetch(`${s.base}/api/leaderboard`)).json();
    assert.equal(lb.top.length, 10);
    assert.deepEqual(lb.top.map((e) => e.score), [300, 300, 150, 140, 130, 120, 110, 100, 90, 80]);
    assert.equal(lb.top[0].name, 'P1', 'ties: earlier entry first');
  } finally {
    await s.close();
  }
});

test('a phone that disconnects mid-round is an abandon, not a score', async () => {
  const s = await boot();
  try {
    const { h } = await host(s.port);
    const { p } = await player(s.port, 'Cara');
    p.send({ type: 'start', seed: 1 });
    await p.next('go');
    await h.next('start');
    p.send({ type: 'begin' });
    await h.next('begin');
    p.close();
    assert.deepEqual(await h.next('abandon'), { type: 'abandon', name: 'Cara' });
    const { welcome } = await player(s.port, 'Dan');
    assert.equal(welcome.status, 'ready', 'the booth frees up after an abandon');
    const lb = await (await fetch(`${s.base}/api/leaderboard`)).json();
    assert.equal(lb.total, 0);
    await settle();
    const events = fs.readFileSync(path.join(s.dataDir, 'events.jsonl'), 'utf8');
    assert.match(events, /"event":"abandon"/);
  } finally {
    await s.close();
  }
});

test('invalid or too-early scores are rejected and not recorded', async () => {
  const s = await boot({ minRoundMs: 60000 });
  try {
    const { h } = await host(s.port);
    const { p } = await player(s.port, 'Eve');
    p.send({ type: 'start', seed: 1 });
    await p.next('go');
    p.send({ type: 'begin' });
    p.send({ type: 'end', score: 100, stats: {} });
    assert.deepEqual(await p.next('error'), { type: 'error', reason: 'rejected' });
    assert.deepEqual(await h.next('abandon'), { type: 'abandon', name: 'Eve' });
    p.close();
  } finally {
    await s.close();
  }
  const s2 = await boot();
  try {
    for (const bad of [-5, 99999, 'abc', 12.5]) {
      const { p } = await player(s2.port, 'Fay');
      p.send({ type: 'start', seed: 1 });
      await p.next('go');
      p.send({ type: 'begin' });
      p.send({ type: 'end', score: bad, stats: {} });
      assert.deepEqual(await p.next('error'), { type: 'error', reason: 'rejected' }, `score ${bad}`);
      p.close();
      await settle(30);
    }
    const lb = await (await fetch(`${s2.base}/api/leaderboard`)).json();
    assert.equal(lb.total, 0);
  } finally {
    await s2.close();
  }
});

test('names are trimmed, capped at 12 characters, and default to Ninja', async () => {
  const s = await boot();
  try {
    const { h } = await host(s.port);
    for (const [raw, want] of [
      ['', 'Ninja'],
      ['   ', 'Ninja'],
      ['abcdefghijklmnopqrstuvwxyz', 'abcdefghijkl'],
      ['さくら  ちゃん', 'さくら ちゃん'],
      [42, 'Ninja'],
    ]) {
      const { p } = await player(s.port, raw);
      p.send({ type: 'start', seed: 1 });
      await p.next('go');
      assert.equal((await h.next('start')).name, want, JSON.stringify(raw));
      p.send({ type: 'quit' });
      await h.next('abandon');
      p.close();
      await settle(30);
    }
  } finally {
    await s.close();
  }
});

test('the lobby tells a late host who is playing', async () => {
  const s = await boot();
  try {
    const { p } = await player(s.port, 'Gus');
    p.send({ type: 'start', seed: 9 });
    await p.next('go');
    const { lobby } = await host(s.port);
    assert.deepEqual(lobby.playing, { name: 'Gus' });
    p.close();
  } finally {
    await s.close();
  }
});
