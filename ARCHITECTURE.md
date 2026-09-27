# Architecture

The contracts every part of Kiru is built against. `DESIGN.md` records the screens; this file records the rules and the wire.

## ARCHITECTURAL INVARIANTS

Three processes: **phone** (`public/play.html` + `public/play.js`), **server** (`server.js`), **host/laptop** (`public/host.html` + `public/host.js`). The phone is authoritative for the game. The server relays and records. The host re-simulates from what the phone sends and never runs its own spawner.

### I1. World coordinates (every boundary that carries a position)
- World is **1.0 wide** (`CONFIG.W`) and **1.75 tall** (`CONFIG.H`), portrait.
- **x** runs left→right, 0 at the left edge, 1 at the right edge.
- **y runs UP from the bottom edge**: y = 0 is the bottom of the playfield, y = 1.75 the top. Items launch from below the screen at `y0 = -0.26` and fall back out at `Y_CULL = -0.35`.
- Units are world units (not pixels, not 0-1 of height). Screen conversion happens only at render, in each client, with this exact mapping for a viewport rect `(rx, ry, rw, rh)` in CSS px:
  `s = min(rw / 1.0, rh / 1.75)`; `ox = rx + (rw - s) / 2`; `screenX = ox + x * s`; `screenY = ry + rh - y * s` (bottom-anchored; extra height on tall phones is empty sky above the world).
- Input on the phone is converted back with the inverse: `x = (px - ox) / s`, `y = (ry + rh - py) / s`.

### I2. Time
- Round time `t` is **seconds (float) since the round began** (the moment the phone sends `begin`). Round length is exactly `21.0`.
- Every time on the wire (`item.t0`, `item.tEnd`, `hit.t`, trail point `t`) is round time in seconds, never wall-clock ms.
- The host sets its own round clock to 0 when it **receives** `begin`, then advances with `performance.now()`. No clock sync: the host's clock simply runs behind the phone's by the one-way network delay (typically 20-80 ms), and because spawn records arrive with that same delay the host still draws each item on its correct path.

### I3. Item motion is closed-form, never integrated
`itemPos(item, t)` in `public/shared/engine.js` is the only motion code. Both phone and host call it:
```
dt  = t - item.t0
x   = item.x0 + item.vx * dt
y   = item.y0 + item.vy * dt - 0.5 * item.g * dt * dt
rot = item.rot0 + item.spin * dt          (radians)
```
Because motion is a pure function of the spawn record and `t`, phone and host cannot drift apart.

### I4. Item (spawn record) - phone → server → host
```
{ id: int (unique per round, starts at 1), kind: 'food'|'bomb'|'star', glyph: string,
  t0: s, x0: world, y0: world, vx: world/s, vy: world/s, g: world/s² (>0, pulls y down),
  spin: rad/s, rot0: rad, size: world (drawn glyph box width), tEnd: s (when y returns to Y_CULL) }
```
Example: `{"id":1,"kind":"food","glyph":"🍣","t0":0.6,"x0":0.41,"y0":-0.26,"vx":0.03,"vy":1.52,"g":0.875,"spin":1.2,"rot0":0.3,"size":0.13,"tEnd":3.93}`

### I5. Hit - phone → server → host
```
{ id: int, kind: 'food'|'bomb'|'star', points: int (signed raw value: food 10, food during frenzy 20, bomb -30, star 10), score: int (total after this hit, ≥0), mult: 1|2, t: s }
```
Hit radius for an item is `item.size * CONFIG.HIT_SCALE` (0.7), in world units.

### I6. WebSocket protocol - path `/ws`, every frame is one JSON object with a `type`
Client → server:
| type | from | fields | server action |
|---|---|---|---|
| `hello` | host | `role:'host'` | reply `lobby` |
| `hello` | player | `role:'player', name` | sanitize name, reply `welcome` with `status:'ready'` if no one holds the claim, else `status:'wait'`; log `join`. A repeated `hello` from the same socket replaces that socket's sanitized name, replies `welcome` with the current status exactly as the first time, and logs `join` again; it never creates a second player entry. If that socket holds the claim, the new name applies only to future rounds (hosts already got `start` with the old name). |
| `start` | player | `seed:int` | if booth free: claim it, reply `go`, broadcast `start` to hosts, log `start`; else reply `welcome{status:'wait'}` |
| `begin` | active player | - | record begin time, broadcast `{type:'begin'}`, log `begin` |
| `spawn` / `slice` / `trail` | active player | see I4, I5, I7 | forward **verbatim** to every host. From any other socket (a host, a waiting player, or a player whose claim has been released) the frame is dropped silently. |
| `end` | active player | `score:int, stats:object` | validate; record; reply `result`; broadcast `end`; free booth; log `end` |
| `quit` | active player | - | same as a disconnect mid-claim |

Server → client:
| type | to | fields |
|---|---|---|
| `lobby` | host | `playUrl: string, leaderboard: Entry[] (top 10), playing: null \| {name}` - resent to all hosts whenever playUrl changes |
| `welcome` | player | `status: 'ready' \| 'wait'` - `ready` is re-sent to every waiting player when the booth frees |
| `go` | player | - |
| `start` | hosts | `name: string, seed: int` |
| `begin` | hosts | - |
| `end` | hosts | `name, score, rank, leaderboard: Entry[] (top 10)` |
| `abandon` | hosts | `name` |
| `result` | player | `score, rank, total, best` |
| `error` | player | `reason: 'rejected'` |

### I7. Trail - phone → server → host
`{ type:'trail', stroke: int (increments each time a finger goes down), pts: [[x, y, t], ...] }`, world coords, batched every 50 ms. The host draws each stroke as a fading polyline and never connects points of different strokes.

### I8. Leaderboard Entry and persistence
- `Entry = { name: string, score: int, ts: ISO-8601 string }`.
- Top list: sort by score descending, ties by earlier `ts` (earlier insertion) first, first 10.
- `rank = 1 + number of stored entries with a strictly greater score`. `total` = number of stored entries. `best` = highest stored score.
- `data/scores.json` holds **every** accepted Entry as a JSON array. Written atomically (write `scores.json.tmp`, then rename) after each accepted `end`. Loaded at startup. The leaderboard never lives only in a browser.
- `data/events.jsonl`: one JSON object per line, `{ ts: ISO string, event: 'join'|'start'|'begin'|'end'|'abandon'|'reject', name?: string, score?: int, reason?: string }`, appended as each happens. `npm run stats` reads it after an event.

---

## SPEC

### Function Signature
`kiru(QR_scan on phone) → one 21-second escalating slash round played on the phone, mirrored live on the laptop → leaderboard entry + laptop sound`

### Engine - `public/shared/engine.js` (ES module, no DOM, no imports; runs in browsers and Node)

Exports exactly: `CONFIG`, `createRng(seed)`, `createRound(seed)`, `itemPos(item, t)`, `segmentHitsCircle(ax, ay, bx, by, cx, cy, r)`.

```js
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
  BOSS: { at: 14.5, hits: 50, points: 5, cooldown: 0.08, size: 0.34, glyph: '🍱',
    x0: 0.5, y0: 1.95, vy: -0.575, g: -0.144, spin: 0.35 },
};
```

**The bento boss** (added 2026-09-26 at the builder's request; the original Kiru had it). At the first spawn opportunity with `ts >= BOSS.at`, one boss item (`kind: 'boss'`) is added alongside that opportunity's normal spawn, using no rng draws, so every other item in the round is unchanged. Its fields come straight from `BOSS` (`vx: 0`, `rot0: 0`, `tEnd: 22`); `g` is negative, so it drifts down from above the screen, bottoms out mid-screen about 4 s later, and floats back up. It does not count toward `maxLive`. A slash that reaches it counts at most once per `cooldown` seconds: `+5 × multiplier`, and the Hit carries `left` (hits remaining). It stays in `items` until `left` reaches 0 (K.O.). `round.boss = { hits, ko }`; `stats` is unchanged.

**`createRng(seed)`**: mulberry32 over `seed >>> 0`. Returns a function yielding floats in [0, 1).

**`createRound(seed)`** returns an object with:
- `seed`, `score` (int, starts 0), `over` (bool), `items` (a `Map<id, Item>` of live, unsliced items), `stats` (`{ foods: int, bombs: int, stars: int }` counts of items sliced by kind).
- `phaseAt(t)` → the name of the phase with `start <= t < end` (`'chaos'` for t ≥ 21).
- `frenzyActive(t)` → `true` iff a star was sliced at `ts` and `ts <= t < ts + 4`.
- `multiplierAt(t)` → `2` if `frenzyActive(t)`, else `1`.
- `update(t)` → `Item[]` newly spawned. Processes every spawn opportunity with scheduled time `<= t`, in order, then deletes from `items` every item with `tEnd <= t`, then sets `over = true` when `t >= 21`.
- `slash(ax, ay, bx, by, t)` → `Hit[]`. Returns `[]` if `over` or `t >= 21` or the segment length `< MIN_SLASH`. Otherwise every item in `items` with `t0 <= t < tEnd` whose position at `t` is within `item.size * HIT_SCALE` of the segment is hit, in order of distance of its projection from `(ax, ay)`. Each hit removes the item from `items` and updates score and stats.

**Spawner (inside `update`)**
- Spawn opportunities are scheduled times `ts`. The first is `SPAWN_START`. After each opportunity, `next = ts + interval` where `interval` is the phase interval at `ts`, times `FRENZY.intervalScale` if `frenzyActive(ts)`. No opportunity is processed at `ts > SPAWN_END`.
- The star: at `createRound`, draw `starT = 6.5 + rng() * 8`. At the first opportunity with `ts >= starT`, spawn the star (regardless of `maxLive`), once per round. That opportunity spawns nothing else.
- Otherwise: `live` = number of items in `items` with `t0 <= ts < tEnd`. If `live >= maxLive` (+ `FRENZY.maxLiveBonus` when frenzy is active at `ts`), spawn nothing. Else spawn one item: bomb with probability `bombP` (0 during frenzy), else a food with a uniformly chosen glyph.
- Item fields: `id` = running counter from 1; `t0 = ts`; `x0 = 0.15 + rng() * 0.70`; `y0 = Y0`; `vx = (0.5 - x0) * 0.35 + (rng() * 0.12 - 0.06)`; `vy = (launch[0] + rng() * (launch[1] - launch[0])) * LAUNCH_SCALE`, times `launchScale` in frenzy; `g = G`, times `gravityScale` in frenzy; `spin = (rng() * 2 - 1) * 2.5`; `rot0 = rng() * 2π`; `size` = `SIZE.food[0] + rng() * (SIZE.food[1] - SIZE.food[0])` for food, `SIZE.bomb`, `SIZE.star`; `tEnd = t0 + (vy + sqrt(vy² + 2·g·(y0 - Y_CULL))) / g`.

**Implementation notes**
- RNG draws per item, in order: bomb roll (always drawn, even when `bombP` is 0), glyph (food only), `x0`, `vx` jitter, `vy`, `spin`, `rot0`, `size` (food only). The host never re-spawns, so only the phone depends on this order.
- Hits are sorted by the clamped projection of the item centre onto the segment. Ties keep id order. A hit counts at distance `<= r`.
- `phaseAt(t < 0)` is `'warmup'`. The star uses the launch range of the phase it spawns in. Frenzy scaling is decided at the spawn opportunity `ts`.
- `update` returns the same objects it stores in `items`. Fields are not rounded.

**Scoring (explicit math)**
- food: `raw = 10 * multiplierAt(t)` (10, or 20 in frenzy)
- bomb: `raw = -30` (never multiplied)
- star: `raw = 10`, then frenzy starts at `t` and runs for 4 s
- `score = max(0, score + raw)`. The Hit carries `points = raw`, `score` after clamping, `mult = multiplierAt(t)` evaluated **before** the hit (so the star's own hit has `mult: 1`).

### Server - `server.js`

Exports `startServer(opts) → Promise<{ port: number, close: () => Promise<void> }>`. When run directly (`node server.js [--tunnel]`), calls `startServer({ port: Number(process.env.PORT) || 8080, dataDir: process.env.KIRU_DATA_DIR || './data', tunnel: argv includes '--tunnel' })` and prints the banner.

`opts`: `port` (0 = ephemeral), `dataDir` (created if missing), `publicDir` (default `<repo>/public`), `tunnel` (bool, default false), `cloudflaredBin` (default `'cloudflared'`, the executable spawned for the tunnel), `log` (bool, default true: print banner and one line per event), `minRoundMs` (default `18000`: an `end` arriving sooner than this after `begin`, or with no `begin`, is rejected), `beginTimeoutMs` (default `10000`), `roundTimeoutMs` (default `40000`). `close()` clears every pending timer, closes every socket, kills the tunnel process, and resolves once the HTTP server has closed.

HTTP (bind `0.0.0.0`):
| Method, path | Response |
|---|---|
| `GET /` | `publicDir/host.html`, `text/html; charset=utf-8` |
| `GET /play` | `publicDir/play.html`, `text/html; charset=utf-8` |
| `GET /<file>` | static file under `publicDir` with a content type by extension (`.html .js .css .svg .png .json .webmanifest`); any decoded path that resolves outside `publicDir` → 404; missing → 404 |
| `GET /api/info` | `{ playUrl, lanUrl, publicUrl }` - `lanUrl = http://<first non-internal IPv4>:<port>` (or `http://localhost:<port>`), `publicUrl` = tunnel URL or `null`, `playUrl = (publicUrl ?? lanUrl) + '/play'` |
| `GET /api/leaderboard` | `{ top: Entry[] (≤10), total: int }` |
| `GET /qr.svg` | `image/svg+xml`, QR of the current `playUrl`, from the `qrcode` package: `QRCode.toString(playUrl, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#1A2040', light: '#FFF8F0' } })` |

All responses send `Cache-Control: no-store`.

Booth rules:
- One active player at a time (the "claim"). The claim is taken by the first `start` while the booth is free.
- The claim is released on: accepted `end`, rejected `end`, `quit`, the active socket closing, no `begin` within `beginTimeoutMs` of `go`, or no `end` within `roundTimeoutMs` of `begin`. Every release except an accepted `end` broadcasts `abandon` to hosts and logs `abandon` (a rejected `end` logs `reject` with `reason` and also broadcasts `abandon`).
- On release, every connected player socket that is not active gets `{ type:'welcome', status:'ready' }`.
- `end` validation: `score` is an integer, `0 <= score <= 5000`, a `begin` was received, and `now - beginAt >= minRoundMs`. On failure reply `{ type:'error', reason:'rejected' }`.
- Name sanitation: if not a string → `'Ninja'`. Remove control characters (`\p{C}`), collapse runs of whitespace to one space, trim, keep the first 12 Unicode code points; empty → `'Ninja'`.
- Malformed JSON frames are ignored (never crash the server). So are frames that parse to a non-object, frames over 64 KiB (the socket is closed), and a `start` from a socket that has not sent `hello` as a player.
- A repeated `begin` from the active player is ignored, so it cannot restart the `minRoundMs` clock.
- `reject` events carry `reason`: `'invalid-score'`, `'no-begin'` or `'too-soon'`.
- A `start` whose `seed` is not an integer is relayed to hosts with `seed: 0`.
- A `scores.json` that is not a JSON array stops startup with an error and is left untouched; the server never overwrites a leaderboard it could not read.
- Stopping the server mid-round logs nothing for that round (it shows up as a `start` with no `end` or `abandon`).

Tunnel (`tunnel: true`): spawn `cloudflared tunnel --no-autoupdate --url http://localhost:<port>`; read stdout and stderr for the first match of `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/`; set `publicUrl`; re-send `lobby` to every host. If `cloudflared` is not installed (spawn `ENOENT`) or exits, print a warning: `Tunnel unavailable: phones must be on the same Wi-Fi as this laptop.` and keep serving the LAN URL. `close()` kills the tunnel process. The tunnel needs the internet, so it is never exercised by `npm test`; it is verified by hand. A test checks that `tunnel: true` with `cloudflaredBin: 'kiru-no-such-binary'` starts cleanly, serves requests, and reports `publicUrl: null`.

Banner printed on start (when `log`):
```
斬 KIRU booth server
  Laptop (host screen):  http://localhost:<port>/
  Phones join at:        <playUrl>
  Scores saved to:       <absolute dataDir>/scores.json
```
When the tunnel URL arrives: `  Public URL ready:      <publicUrl>/play  (QR updated)`

### Phone and host screens
Every verbatim string, state and effect is recorded in `DESIGN.md`, the design document of record for both surfaces. Shared rendering lives in `public/shared/draw.js` and uses the I1 view mapping (`makeView`). Test hooks are read-only: `window.kiruTest` (phone: `mode`, `targets()`) and `window.kiruHost` (laptop: `state`, `liveItems`, `score`, `audio`, `board()`); `test-e2e/e2e.js` depends on them.

---

## CONSTRAINTS

### In Scope
The engine, the relay server with durable leaderboard and event log, the phone controller, the laptop crowd display with sound and music, booth networking via Cloudflare quick tunnel with LAN fallback.

### Out of Scope (kill list)
Accounts, auth, email capture, CampusGroups CTA, rooms/room codes, multiple simultaneous players, combos, haptics, name profanity filtering, practice/offline mode, analytics dashboards, a database, any build step or bundler, any CDN or external runtime request (the booth may be offline apart from the tunnel).

### Tech Stack
Node ≥ 20 (developed on 25.9). Runtime deps: `ws@8.22.0`, `qrcode@1.5.4`. Dev dep: `playwright-core@1.63.0` (drives the installed Google Chrome for e2e; never downloads a browser). Tests: `node:test` + `node:assert/strict`. Browser code: vanilla ES modules, Canvas 2D, Web Audio. No frameworks, no TypeScript.

### Architecture
```
phone (play.js + engine.js) ──ws──► server.js ──ws──► host (host.js + engine.js)
                                        │
                                data/scores.json, data/events.jsonl
```

---
