// Kiru booth server: relays phone → host frames and records finished rounds to disk.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_SCORE = 5000;
const TOP_N = 10;
const MAX_FRAME_BYTES = 64 * 1024;
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const TUNNEL_WARNING = 'Tunnel unavailable: phones must be on the same Wi-Fi as this laptop.';
const RELAYED = new Set(['spawn', 'slice', 'trail']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Ninja';
  const cleaned = raw.replace(/\p{C}/gu, '').replace(/\s+/gu, ' ').trim();
  const name = Array.from(cleaned).slice(0, 12).join('');
  return name === '' ? 'Ninja' : name;
}

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

function loadScores(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  let entries;
  try {
    entries = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON. Move it aside (npm run reset-scores) before starting.`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(`${file} must hold a JSON array of entries. Move it aside (npm run reset-scores) before starting.`);
  }
  return entries;
}

function byRank(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

export async function startServer(opts = {}) {
  const {
    port: wantPort = 8080,
    publicDir = path.join(REPO_DIR, 'public'),
    tunnel = false,
    cloudflaredBin = 'cloudflared',
    log = true,
    minRoundMs = 18000,
    beginTimeoutMs = 10000,
    roundTimeoutMs = 40000,
  } = opts;
  const dataDir = path.resolve(opts.dataDir ?? './data');
  const publicRoot = path.resolve(publicDir);
  const scoresFile = path.join(dataDir, 'scores.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');

  fs.mkdirSync(dataDir, { recursive: true });
  const entries = loadScores(scoresFile);

  const say = (line) => {
    if (log) console.log(line);
  };

  function logEvent(event, fields = {}) {
    const ev = { ts: new Date().toISOString(), event, ...fields };
    try {
      fs.appendFileSync(eventsFile, JSON.stringify(ev) + '\n');
    } catch (err) {
      console.error(`kiru: could not append to ${eventsFile}: ${err.message}`);
    }
    say(`  ${ev.ts}  ${event}${ev.name !== undefined ? `  ${ev.name}` : ''}${ev.score !== undefined ? `  ${ev.score}` : ''}${ev.reason ? `  (${ev.reason})` : ''}`);
  }

  function saveScores() {
    const tmp = `${scoresFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
      fs.renameSync(tmp, scoresFile);
    } catch (err) {
      console.error(`kiru: could not save ${scoresFile}: ${err.message}`);
    }
  }

  const top = () => [...entries].sort(byRank).slice(0, TOP_N);

  // ---- URLs ----
  let port = 0;
  let publicUrl = null;
  const lanUrl = () => `http://${lanAddress()}:${port}`;
  const playUrl = () => `${publicUrl ?? lanUrl()}/play`;

  // ---- HTTP ----
  function send(res, status, type, body) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  }
  const sendJson = (res, obj) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(obj));
  const notFound = (res) => send(res, 404, 'text/plain; charset=utf-8', 'Not found');

  function serveFile(res, relPath) {
    let decoded;
    try {
      decoded = decodeURIComponent(relPath);
    } catch {
      return notFound(res);
    }
    const file = path.resolve(publicRoot, '.' + path.sep + decoded);
    if (decoded.includes('\0') || !file.startsWith(publicRoot + path.sep)) return notFound(res);
    fs.readFile(file, (err, data) => {
      if (err) return notFound(res);
      send(res, 200, CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', data);
    });
  }

  async function handle(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    switch (pathname) {
      case '/':
        return serveFile(res, 'host.html');
      case '/play':
        return serveFile(res, 'play.html');
      case '/api/info':
        return sendJson(res, { playUrl: playUrl(), lanUrl: lanUrl(), publicUrl });
      case '/api/leaderboard':
        return sendJson(res, { top: top(), total: entries.length });
      case '/qr.svg': {
        const svg = await QRCode.toString(playUrl(), {
          type: 'svg',
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#1A2040', light: '#FFF8F0' },
        });
        return send(res, 200, 'image/svg+xml', svg);
      }
      default:
        return serveFile(res, pathname.slice(1));
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`kiru: ${req.method} ${req.url} failed: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Server error');
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wantPort, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = server.address().port;

  // ---- Booth state ----
  const hosts = new Set();
  const players = new Map(); // socket -> sanitized name
  let claim = null; // { ws, name, beginAt, timer }
  let closing = false;

  const sendTo = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const toHosts = (msg) => {
    const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const h of hosts) if (h.readyState === h.OPEN) h.send(text);
  };
  const lobby = () => ({ type: 'lobby', playUrl: playUrl(), leaderboard: top(), playing: claim ? { name: claim.name } : null });

  // outcome: 'end' (accepted), 'abandon', or { reject: reason }
  function release(outcome) {
    const { ws, name, timer } = claim;
    clearTimeout(timer);
    claim = null;
    if (outcome !== 'end') {
      toHosts({ type: 'abandon', name });
      if (outcome === 'abandon') logEvent('abandon', { name });
      else logEvent('reject', { name, reason: outcome.reject });
    }
    for (const p of players.keys()) if (p !== ws) sendTo(p, { type: 'welcome', status: 'ready' });
  }

  function onEnd(msg) {
    const { score } = msg;
    let reason = null;
    if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) reason = 'invalid-score';
    else if (claim.beginAt === null) reason = 'no-begin';
    else if (Date.now() - claim.beginAt < minRoundMs) reason = 'too-soon';
    if (reason) {
      sendTo(claim.ws, { type: 'error', reason: 'rejected' });
      release({ reject: reason });
      return;
    }
    const entry = { name: claim.name, score, ts: new Date().toISOString() };
    entries.push(entry);
    saveScores();
    const rank = 1 + entries.filter((e) => e.score > score).length;
    const best = Math.max(...entries.map((e) => e.score));
    sendTo(claim.ws, { type: 'result', score, rank, total: entries.length, best });
    toHosts({ type: 'end', name: entry.name, score, rank, leaderboard: top() });
    logEvent('end', { name: entry.name, score });
    release('end');
  }

  function onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg === null || typeof msg !== 'object') return;
    const isActive = claim !== null && claim.ws === ws;

    if (msg.type === 'hello') {
      if (msg.role === 'host') {
        players.delete(ws);
        hosts.add(ws);
        sendTo(ws, lobby());
      } else if (msg.role === 'player') {
        hosts.delete(ws);
        const name = sanitizeName(msg.name);
        players.set(ws, name);
        sendTo(ws, { type: 'welcome', status: claim ? 'wait' : 'ready' });
        logEvent('join', { name });
      }
      return;
    }
    if (RELAYED.has(msg.type)) {
      if (isActive) toHosts(String(raw));
      return;
    }
    switch (msg.type) {
      case 'start': {
        if (!players.has(ws)) return;
        if (claim) {
          sendTo(ws, { type: 'welcome', status: 'wait' });
          return;
        }
        const name = players.get(ws);
        const seed = Number.isInteger(msg.seed) ? msg.seed : 0;
        claim = { ws, name, beginAt: null, timer: setTimeout(() => release('abandon'), beginTimeoutMs) };
        sendTo(ws, { type: 'go' });
        toHosts({ type: 'start', name, seed });
        logEvent('start', { name });
        return;
      }
      case 'begin':
        if (!isActive || claim.beginAt !== null) return;
        claim.beginAt = Date.now();
        clearTimeout(claim.timer);
        claim.timer = setTimeout(() => release('abandon'), roundTimeoutMs);
        toHosts({ type: 'begin' });
        logEvent('begin', { name: claim.name });
        return;
      case 'end':
        if (isActive) onEnd(msg);
        return;
      case 'quit':
        if (isActive) release('abandon');
    }
  }

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_FRAME_BYTES });
  wss.on('error', (err) => console.error(`kiru: websocket server error: ${err.message}`));
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => onMessage(ws, raw));
    ws.on('error', (err) => say(`  websocket error: ${err.message}`));
    ws.on('close', () => {
      hosts.delete(ws);
      players.delete(ws);
      if (!closing && claim && claim.ws === ws) release('abandon');
    });
  });

  // ---- Tunnel ----
  let tunnelProc = null;
  if (tunnel) {
    let warned = false;
    const tunnelDown = () => {
      tunnelProc = null;
      if (closing) return;
      if (!warned) {
        warned = true;
        say(TUNNEL_WARNING);
      }
      if (publicUrl !== null) {
        publicUrl = null;
        toHosts(lobby());
      }
    };
    tunnelProc = spawn(cloudflaredBin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let seen = '';
    const scan = (chunk) => {
      if (publicUrl !== null) return;
      seen = (seen + chunk).slice(-4096);
      const m = seen.match(TUNNEL_URL_RE);
      if (!m) return;
      publicUrl = m[0];
      say(`  Public URL ready:      ${publicUrl}/play  (QR updated)`);
      toHosts(lobby());
    };
    tunnelProc.stdout.on('data', scan);
    tunnelProc.stderr.on('data', scan);
    tunnelProc.on('error', tunnelDown);
    tunnelProc.on('exit', tunnelDown);
  }

  say('斬 KIRU booth server');
  say(`  Laptop (host screen):  http://localhost:${port}/`);
  say(`  Phones join at:        ${playUrl()}`);
  say(`  Scores saved to:       ${scoresFile}`);

  async function close() {
    closing = true;
    if (claim) clearTimeout(claim.timer);
    claim = null;
    if (tunnelProc) tunnelProc.kill();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }

  return { port, close };
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const srv = await startServer({
    port: Number(process.env.PORT) || 8080,
    dataDir: process.env.KIRU_DATA_DIR || './data',
    tunnel: process.argv.includes('--tunnel'),
  });
  const stop = () => srv.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
