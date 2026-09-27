# 斬 Kiru

[▶ Watch the 30-second demo](demo/kiru-demo.mp4)

A Fruit Ninja-style booth game for the Johnson Japan Club. A visitor scans the QR code on the laptop and plays on their own phone, slashing Japanese food as it flies up the screen. The crowd watches the same round live on the laptop, which also plays the music and sound and keeps the leaderboard.

A round lasts 21 seconds and gets harder as it goes:

| Time | Phase | What flies |
|---|---|---|
| 0–6 s | 準備 Warm-up | food only |
| 6–14 s | 本番 The real game | about 1 bomb in 5 |
| 14–21 s | 混沌 Chaos | almost half bombs, more items at once |

Food is **+10** and a bomb is **−30**. The score never goes below 0. Each round has exactly one ⭐, somewhere between 6.5 and 10 s. Slicing it starts a 4-second frenzy: food flies faster, no new bombs appear, and food is worth ×2.

At 14.5 s a 🍱 bento boss drifts down from the top of the screen. It survives each slash, counts at most one hit every 0.08 s, and pays +5 a hit. Fifty hits knock it out.

## Run it at the booth

You need Node 20 or newer, Google Chrome on the laptop, and `cloudflared`. Install `cloudflared` once with `brew install cloudflared`.

```bash
cd kiru
npm ci
npm run booth
```

1. Open **http://localhost:8080** in Chrome on the laptop.
2. Click **CLICK TO OPEN THE BOOTH**. This turns on sound and music and goes full screen.
3. Within a few seconds the QR code switches to a `…trycloudflare.com/play` address, and the line under it reads *"Works on any network, cellular too"*. Phones can now scan it from any network, including cellular and eduroam.

Stop the server with **Ctrl-C**. Scores are saved to `data/scores.json` after every round and are reloaded the next time the server starts.

Laptop keys: **M** turns the music on and off (sound effects stay on). **F** toggles full screen.

### Before the event (5 minutes)

- Keep the laptop awake. In a second terminal, run `caffeinate -dis` and leave it running.
- Turn the volume up and plug the laptop in.
- Scan the QR with your own phone **with Wi-Fi turned off** and play one round. If it works on cellular, it will work for visitors.
- Optional: run `npm run reset-scores` (with the server stopped) to start a fresh board. Old scores are moved to `data/archive-<date>/`, never deleted.

### If there is no internet at the venue

Run `npm start` instead of `npm run booth`. The QR code then shows the laptop's local address, with a yellow note: *"Phones: join the same Wi-Fi as this laptop"*. That only works on a network that lets devices see each other. University and venue Wi-Fi usually blocks this, but a phone hotspot that both the laptop and the players join does not.

### After the event

```bash
npm run stats
```

This prints how many rounds were started, finished and abandoned, the median and best score, and a one-line verdict on the goal this build was made to test: at least 15 finished rounds per two-hour shift, with no more than a quarter of rounds abandoned. Reset scores between events so the per-hour rate covers one event only.

## How it works

```
 phone (play.js)  ──ws──►  server.js  ──ws──►  laptop (host.js)
 runs the round,            relays, keeps        redraws the round,
 detects slashes            one player at        sound + music,
                            a time, saves        leaderboard
                                 │
                   data/scores.json, data/events.jsonl
```

The phone runs the game. It sends each item once, when the item spawns, and the laptop computes every item's flight with the same closed-form function (`public/shared/engine.js`). The two screens therefore can't drift apart, and the laptop only lags by one network hop. If a second phone scans mid-round, it is told to wait and is let in when the round ends. `ARCHITECTURE.md` is the full specification.

## Develop

```bash
npm test            # 49 unit/integration tests: engine rules and bots, server, reset
npm run lint        # syntax check of every .js file
npm run e2e         # headless Chrome: an emulated iPhone plays a full round against the laptop page
npm run e2e:tunnel  # same, but the phones load through a real Cloudflare tunnel
npm run sim         # score distributions for a careful bot vs. a button-masher
npm run verify      # lint + test + e2e
```

The e2e scripts drive the Google Chrome you already have installed through `playwright-core`, and they never download a browser. They save screenshots to `test-e2e/out/`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The QR shows a numeric address with the yellow Wi-Fi note after `npm run booth` | The tunnel did not start. Check the terminal for `Tunnel unavailable`, check the laptop's internet, and restart `npm run booth`. |
| Phones show "Can't reach the booth. Retrying…" | The server stopped, or the tunnel address changed after a restart. Have them rescan the QR (it always shows the current address). |
| No sound | Click the booth gate once after loading the page, and check the laptop volume. **M** may have muted the music. |
| A phone says "Someone's mid-round" | That is the queue. Their PLAY button turns on when the current round ends. |
| The round was cancelled | The player's phone locked, switched apps or lost connection. Cancelled rounds are not scored. |
