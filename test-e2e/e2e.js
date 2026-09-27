// End-to-end: a laptop page and an emulated iPhone in the installed Google
// Chrome, against a real server. The phone plays a full 21 s round with real
// touch swipes aimed at live food; the laptop must mirror it and the score must
// land on the leaderboard. A second phone must be told to wait, then be freed.
// Screenshots go to test-e2e/out/ for a human to look at.
// KIRU_E2E_TUNNEL=1 opens a real Cloudflare quick tunnel and loads the phones
// through the public https URL, the way a visitor on cellular would.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';
import { startServer } from '../server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures.push(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiru-e2e-'));
const viaTunnel = process.env.KIRU_E2E_TUNNEL === '1';
const server = await startServer({ port: 0, dataDir, log: false, tunnel: viaTunnel });
const base = `http://127.0.0.1:${server.port}`;
let phoneBase = base;
if (viaTunnel) {
  for (let i = 0; i < 60 && phoneBase === base; i++) {
    const info = await (await fetch(`${base}/api/info`)).json();
    if (info.publicUrl) phoneBase = info.publicUrl;
    else await sleep(500);
  }
  if (phoneBase === base) {
    console.log('FAIL tunnel did not come up within 30 s');
    await server.close();
    process.exit(1);
  }
  for (let i = 0; i < 20; i++) {
    try {
      if ((await fetch(`${phoneBase}/play`)).ok) break;
    } catch {
      // DNS for a fresh trycloudflare host takes a few seconds
    }
    await sleep(1000);
  }
  console.log(`phones load ${phoneBase}/play`);
}
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const killer = setTimeout(() => {
  console.log('FAIL e2e timed out after 120 s');
  process.exit(1);
}, 120000);

try {
  const errors = [];
  const watch = (page, label) => {
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${label} console: ${m.text()}`));
  };

  // Laptop
  const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const host = await hostCtx.newPage();
  watch(host, 'host');
  await host.goto(`${base}/`);
  await host.click('#gate');
  await host.waitForFunction(() => window.kiruHost && window.kiruHost.state === 'idle');
  check(await host.evaluate(() => window.kiruHost.audio), 'laptop audio unlocked by the click gate');
  await host.waitForFunction(() => document.querySelector('#qr').naturalWidth > 0, null, { timeout: 5000 });
  check(true, 'laptop shows the QR code');
  if (viaTunnel) await host.waitForFunction(() => document.querySelector('#url').textContent.includes('trycloudflare.com'), null, { timeout: 5000 });
  check((await host.textContent('#url')).endsWith('/play'), 'laptop shows the play URL');
  check((await host.textContent('#board')).includes('Be the first'), 'empty leaderboard invites the first player');
  await sleep(1500);
  await host.screenshot({ path: path.join(out, 'host-idle.png') });

  // Phone 1
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const phone = await phoneCtx.newPage();
  watch(phone, 'phone');
  await phone.goto(`${phoneBase}/play`);
  await phone.waitForSelector('#play:not([disabled])', { timeout: 5000 });
  check(true, 'phone connects and PLAY is enabled');
  await phone.screenshot({ path: path.join(out, 'phone-join.png') });
  await phone.fill('#name', 'E2E Tester');
  await phone.tap('#play');

  await host.waitForFunction(() => window.kiruHost.state === 'count', null, { timeout: 5000 });
  check(true, 'laptop runs the countdown when the phone starts');
  await phone.waitForFunction(() => window.kiruTest.mode === 'play', null, { timeout: 6000 });
  await host.waitForFunction(() => window.kiruHost.state === 'live', null, { timeout: 2000 });
  check(true, 'phone and laptop both enter the live round');

  // Phone 2 arrives mid-round and must wait
  const phone2Ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const phone2 = await phone2Ctx.newPage();
  watch(phone2, 'phone2');
  await phone2.goto(`${phoneBase}/play`);
  await phone2.waitForFunction(() => document.querySelector('#status').textContent.includes('mid-round'), null, { timeout: 5000 });
  check(await phone2.isDisabled('#play'), 'a second phone is told to wait while someone plays');

  // Play: swipe through live food with real touch events
  const cdp = await phoneCtx.newCDPSession(phone);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  let swipes = 0;
  let sawHostItems = 0;
  let shotMid = false;
  const started = Date.now();
  while (Date.now() - started < 22000) {
    const mode = await phone.evaluate(() => window.kiruTest.mode);
    if (mode !== 'play') break;
    const targets = await phone.evaluate(() => window.kiruTest.targets());
    const vp = phone.viewportSize();
    const food = targets.find((t) => t.kind !== 'bomb' && t.y > vp.height * 0.3 && t.y < vp.height * 0.85 && t.x > 30 && t.x < vp.width - 30);
    if (food) {
      await touch('touchStart', food.x - 45, food.y + 6);
      for (let i = 1; i <= 6; i++) await touch('touchMove', food.x - 45 + i * 15, food.y + 6 - i * 2);
      await touch('touchEnd');
      swipes++;
    }
    sawHostItems = Math.max(sawHostItems, await host.evaluate(() => window.kiruHost.liveItems));
    if (!shotMid && Date.now() - started > 9000) {
      shotMid = true;
      await host.screenshot({ path: path.join(out, 'host-live.png') });
      await phone.screenshot({ path: path.join(out, 'phone-live.png') });
    }
    await sleep(90);
  }
  check(swipes >= 10, `phone received real swipes (${swipes})`);
  check(sawHostItems > 0, `laptop drew the phone's items (${sawHostItems} at peak)`);

  await phone.waitForFunction(() => window.kiruTest.mode === 'over', null, { timeout: 6000 });
  await phone.waitForFunction(() => document.querySelector('#rank').textContent.startsWith('#'), null, { timeout: 6000 });
  const finalScore = Number(await phone.textContent('#final'));
  check(finalScore > 0, `slashing scored points end to end (${finalScore})`);
  check((await phone.textContent('#rank')).startsWith('#1 of 1'), 'phone shows its rank');

  await host.waitForFunction(() => window.kiruHost.state === 'result', null, { timeout: 3000 });
  await sleep(600);
  await host.screenshot({ path: path.join(out, 'host-result.png') });
  await phone.screenshot({ path: path.join(out, 'phone-result.png') });
  const board = await host.evaluate(() => window.kiruHost.board());
  check(board.length === 1 && board[0].name === 'E2E Tester' && board[0].score === finalScore, `laptop leaderboard shows E2E Tester ${finalScore}`);
  check((await host.textContent('#resScore')) === String(finalScore), 'laptop result screen matches the phone score');

  const lb = await (await fetch(`${base}/api/leaderboard`)).json();
  check(lb.total === 1 && lb.top[0].score === finalScore, 'score persisted on the server');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'scores.json'), 'utf8'));
  check(saved.length === 1 && saved[0].score === finalScore, 'score written to scores.json');

  await phone2.waitForSelector('#play:not([disabled])', { timeout: 3000 });
  check(true, 'the waiting phone is freed when the round ends');

  await host.waitForFunction(() => window.kiruHost.state === 'idle', null, { timeout: 9000 });
  check(true, 'laptop returns to the attract screen');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  check(false, `e2e threw: ${e.message}`);
} finally {
  clearTimeout(killer);
  await browser.close();
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} e2e check(s) failed` : '\ne2e: all checks passed');
process.exit(failures.length ? 1 : 0);
