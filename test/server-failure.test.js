// Server checks beyond the acceptance contract: failure paths, the tunnel
// fallback, timers, and repeated hello. No test starts a real tunnel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server.js';

let publicDir;
const tmpDirs = [];

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

before(() => {
  publicDir = tmp('kiru-public-');
  fs.writeFileSync(path.join(publicDir, 'host.html'), '<!doctype html><title>host-fixture</title>');
});

after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function boot(opts = {}) {
  const dataDir = opts.dataDir ?? tmp('kiru-data-');
  const srv = await startServer({ port: 0, dataDir, publicDir, tunnel: false, log: false, minRoundMs: 0, ...opts });
  return { ...srv, dataDir, base: `http://127.0.0.1:${srv.port}` };
}

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
    send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
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
const readEvents = (dataDir) =>
  fs
    .readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

async function connect(port, hello) {
  const c = client(port);
  await c.opened;
  c.send(hello);
  return c;
}

// A stand-in for cloudflared: prints a quick-tunnel URL on stderr, then either stays up or exits.
function fakeCloudflared(exitAfterMs) {
  const dir = tmp('kiru-bin-');
  const bin = path.join(dir, 'fake-cloudflared');
  const tail = exitAfterMs === null ? 'setInterval(() => {}, 1000);' : `setTimeout(() => process.exit(1), ${exitAfterMs});`;
  fs.writeFileSync(
    bin,
    `#!${process.execPath}\nprocess.stderr.write('INF |  https://kiru-test-abc.trycloudflare.com  |\\n');\n${tail}\n`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

test('tunnel: a missing cloudflared binary falls back to the LAN URL and keeps serving', async () => {
  const s = await boot({ tunnel: true, cloudflaredBin: 'kiru-no-such-binary' });
  try {
    await settle();
    const info = await (await fetch(`${s.base}/api/info`)).json();
    assert.equal(info.publicUrl, null);
    assert.equal(info.playUrl, `${info.lanUrl}/play`);
    assert.equal((await fetch(`${s.base}/`)).status, 200);
    const h = await connect(s.port, { type: 'hello', role: 'host' });
    assert.equal((await h.next('lobby')).playUrl, info.playUrl);
    h.close();
  } finally {
    await s.close();
  }
});

test('tunnel: the quick-tunnel URL becomes the play URL and hosts get a fresh lobby', async () => {
  const s = await boot({ tunnel: true, cloudflaredBin: fakeCloudflared(null) });
  try {
    const h = await connect(s.port, { type: 'hello', role: 'host' });
    let lobby = await h.next('lobby');
    if (!lobby.playUrl.includes('trycloudflare')) lobby = await h.next('lobby');
    assert.equal(lobby.playUrl, 'https://kiru-test-abc.trycloudflare.com/play');
    const info = await (await fetch(`${s.base}/api/info`)).json();
    assert.equal(info.publicUrl, 'https://kiru-test-abc.trycloudflare.com');
    assert.equal(info.playUrl, 'https://kiru-test-abc.trycloudflare.com/play');
    h.close();
  } finally {
    await s.close();
  }
});

test('tunnel: when cloudflared exits, the play URL falls back to the LAN and hosts are told', async () => {
  const s = await boot({ tunnel: true, cloudflaredBin: fakeCloudflared(300) });
  try {
    const h = await connect(s.port, { type: 'hello', role: 'host' });
    let sawTunnel = false;
    for (;;) {
      const { playUrl } = await h.next('lobby', 3000);
      if (playUrl.includes('trycloudflare')) sawTunnel = true;
      else if (sawTunnel) break;
    }
    const info = await (await fetch(`${s.base}/api/info`)).json();
    assert.equal(info.publicUrl, null);
    h.close();
  } finally {
    await s.close();
  }
});

test('malformed and non-object frames are ignored and the server keeps working', async () => {
  const s = await boot();
  try {
    const h = await connect(s.port, { type: 'hello', role: 'host' });
    await h.next('lobby');
    const p = client(s.port);
    await p.opened;
    for (const junk of ['{not json', 'null', '42', '"hello"', '[]', '{"type":"nope"}']) p.send(junk);
    p.ws.send(Buffer.from([0xff, 0x00, 0x7b]));
    await settle();
    assert.equal(p.ws.readyState, WebSocket.OPEN);
    const info = await fetch(`${s.base}/api/info`);
    assert.equal(info.status, 200);
    p.send({ type: 'hello', role: 'player', name: 'Hana' });
    assert.equal((await p.next('welcome')).status, 'ready');
    p.close();
    h.close();
  } finally {
    await s.close();
  }
});

test('relay frames from a host are dropped, and start from a host is ignored', async () => {
  const s = await boot();
  try {
    const h1 = await connect(s.port, { type: 'hello', role: 'host' });
    const h2 = await connect(s.port, { type: 'hello', role: 'host' });
    await h1.next('lobby');
    await h2.next('lobby');
    h1.send({ type: 'start', seed: 1 });
    h1.send({ type: 'spawn', item: { id: 1 } });
    await settle();
    assert.equal(h2.has('spawn'), false);
    assert.equal(h2.has('start'), false);
    h1.close();
    h2.close();
  } finally {
    await s.close();
  }
});

test('no begin within beginTimeoutMs releases the claim as an abandon', async () => {
  const s = await boot({ beginTimeoutMs: 100 });
  try {
    const h = await connect(s.port, { type: 'hello', role: 'host' });
    await h.next('lobby');
    const p = await connect(s.port, { type: 'hello', role: 'player', name: 'Ito' });
    await p.next('welcome');
    const w = await connect(s.port, { type: 'hello', role: 'player', name: 'Jun' });
    await w.next('welcome');
    p.send({ type: 'start', seed: 1 });
    await p.next('go');
    w.send({ type: 'start', seed: 2 });
    assert.equal((await w.next('welcome')).status, 'wait');
    assert.deepEqual(await h.next('abandon'), { type: 'abandon', name: 'Ito' });
    assert.equal((await w.next('welcome')).status, 'ready');
    p.send({ type: 'begin' });
    await settle();
    assert.equal(h.has('begin'), false, 'a released player cannot begin');
    p.close();
    w.close();
    h.close();
  } finally {
    await s.close();
  }
});

test('no end within roundTimeoutMs releases the claim as an abandon', async () => {
  const s = await boot({ roundTimeoutMs: 100 });
  try {
    const h = await connect(s.port, { type: 'hello', role: 'host' });
    await h.next('lobby');
    const p = await connect(s.port, { type: 'hello', role: 'player', name: 'Kai' });
    await p.next('welcome');
    p.send({ type: 'start', seed: 1 });
    await p.next('go');
    p.send({ type: 'begin' });
    await h.next('begin');
    assert.deepEqual(await h.next('abandon'), { type: 'abandon', name: 'Kai' });
    p.send({ type: 'end', score: 100, stats: {} });
    await settle();
    assert.equal(p.has('result'), false, 'a late end is dropped');
    const lb = await (await fetch(`${s.base}/api/leaderboard`)).json();
    assert.equal(lb.total, 0);
    p.close();
    h.close();
  } finally {
    await s.close();
  }
});

test('an end with no begin is rejected, logged as reject, and hosts see an abandon', async () => {
  const s = await boot();
  try {
    const h = await connect(s.port, { type: 'hello', role: 'host' });
    await h.next('lobby');
    const p = await connect(s.port, { type: 'hello', role: 'player', name: 'Lin' });
    await p.next('welcome');
    p.send({ type: 'start', seed: 1 });
    await p.next('go');
    p.send({ type: 'end', score: 50, stats: {} });
    assert.deepEqual(await p.next('error'), { type: 'error', reason: 'rejected' });
    assert.deepEqual(await h.next('abandon'), { type: 'abandon', name: 'Lin' });
    const events = readEvents(s.dataDir);
    const reject = events.find((e) => e.event === 'reject');
    assert.equal(reject.name, 'Lin');
    assert.equal(reject.reason, 'no-begin');
    assert.equal(events.some((e) => e.event === 'abandon'), false, 'a reject is not double-counted as abandon');
    p.close();
    h.close();
  } finally {
    await s.close();
  }
});

test('a repeated hello replaces the name, replies welcome again, logs join again, and never retitles a live claim', async () => {
  const s = await boot();
  try {
    const h = await connect(s.port, { type: 'hello', role: 'host' });
    await h.next('lobby');
    const p = await connect(s.port, { type: 'hello', role: 'player', name: 'Stored' });
    assert.equal((await p.next('welcome')).status, 'ready');
    p.send({ type: 'hello', role: 'player', name: 'Typed' });
    assert.equal((await p.next('welcome')).status, 'ready');
    p.send({ type: 'start', seed: 7 });
    await p.next('go');
    assert.equal((await h.next('start')).name, 'Typed');

    p.send({ type: 'hello', role: 'player', name: 'Later' });
    assert.equal((await p.next('welcome')).status, 'wait', 'status is reported exactly as for a first hello');
    p.send({ type: 'begin' });
    await h.next('begin');
    p.send({ type: 'end', score: 70, stats: {} });
    await p.next('result');
    assert.equal((await h.next('end')).name, 'Typed', 'the live round keeps the name hosts were given');

    p.send({ type: 'start', seed: 8 });
    await p.next('go');
    assert.equal((await h.next('start')).name, 'Later', 'the new name applies to the next round');

    const joins = readEvents(s.dataDir).filter((e) => e.event === 'join').map((e) => e.name);
    assert.deepEqual(joins, ['Stored', 'Typed', 'Later']);
    p.close();
    await h.next('abandon');
    const q = await connect(s.port, { type: 'hello', role: 'player', name: 'Mei' });
    assert.equal((await q.next('welcome')).status, 'ready', 'one socket is one player: no ghost entry holds the booth');
    q.close();
    h.close();
  } finally {
    await s.close();
  }
});

test('a corrupt scores.json stops startup and is left untouched', async () => {
  const dataDir = tmp('kiru-data-');
  const file = path.join(dataDir, 'scores.json');
  fs.writeFileSync(file, '[{"name":"Aiko","score":1');
  await assert.rejects(boot({ dataDir }), /scores\.json is not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '[{"name":"Aiko","score":1');
  fs.writeFileSync(file, '{"name":"Aiko"}');
  await assert.rejects(boot({ dataDir }), /must hold a JSON array/);
});

test('scores are written atomically with no temp file left behind; the data dir is created if missing', async () => {
  const dataDir = path.join(tmp('kiru-data-'), 'nested', 'data');
  const s = await boot({ dataDir });
  try {
    const p = await connect(s.port, { type: 'hello', role: 'player', name: 'Nao' });
    await p.next('welcome');
    p.send({ type: 'start', seed: 1 });
    await p.next('go');
    p.send({ type: 'begin' });
    p.send({ type: 'end', score: 40, stats: {} });
    await p.next('result');
    assert.deepEqual(fs.readdirSync(dataDir).sort(), ['events.jsonl', 'scores.json']);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'scores.json'), 'utf8'));
    assert.equal(saved.length, 1);
    assert.deepEqual(Object.keys(saved[0]), ['name', 'score', 'ts']);
    p.close();
  } finally {
    await s.close();
  }
});

test('HTTP: missing play page is a 404, other methods are refused, and every response is no-store', async () => {
  const s = await boot();
  try {
    const play = await fetch(`${s.base}/play`);
    assert.equal(play.status, 404);
    assert.equal(play.headers.get('cache-control'), 'no-store');
    const post = await fetch(`${s.base}/api/leaderboard`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal((await fetch(`${s.base}/%E0%A4%A`)).status, 404, 'a bad percent-encoding is a 404, not a crash');
    for (const p of ['/', '/api/info', '/api/leaderboard', '/qr.svg']) {
      assert.equal((await fetch(`${s.base}${p}`)).headers.get('cache-control'), 'no-store', p);
    }
  } finally {
    await s.close();
  }
});
