# DESIGN.md — screens of record

The phone and laptop surfaces as built. If a screen and this file disagree, one of them is a bug. Rules and protocol live in `ARCHITECTURE.md`.

## Palette (from the original Kiru host/play source)
`#1A2040` navy · `#1E2550` / `#221848` gradient depth · `#F06896` rose · `#B0A8C8` lavender · `#F0B860` gold · `#88C8A0` green (points) · `#D81C2F` red (bombs) · `#FFF8F0` cream (text, QR background).
Title shadow: `0 0 40px rgba(240,104,150,0.5), 0 0 80px rgba(240,104,150,0.2), 0 2px 0 #A04060`.

## Phone (`/play`)
| Screen | Verbatim strings |
|---|---|
| Join | `斬` `KIRU` · `Slice the food. Dodge the bombs.` · `🍣 +10  💣 −30  ⭐ ×2` · placeholder `Your name` · button `PLAY` · `Johnson Japan Club · Cornell` |
| Join status | `Connecting…` · `Can't reach the booth. Retrying…` · `Starting…` · `Someone's mid-round. You're next, hang tight.` |
| Countdown | `3` `2` `1` `斬!` (0.7 s each, 0.45 s on 斬) · `Watch the big screen too 👀` |
| Play HUD | score (top left) · seconds left (top right, red at ≤3) · pink→gold time bar · `×2 FRENZY` badge |
| Banners | `準備 WARM-UP` / `Food only. Get a feel for it.` · `本番 THE REAL GAME` / `Bombs incoming.` · `混沌 CHAOS` / `Almost half are bombs. Pick your cuts.` · `⭐ FRENZY ×2` / `No new bombs. Go wild.` · `🍱 BENTO BOSS` / `Slash it fast. 50 hits to knock it out.` · `K.O.!` / `Bento boss down.` |
| Popups | `+10` green · `+20` gold · `−30` red · `×2 FRENZY` gold · `+5` gold (boss) · `K.O.!` gold |
| Boss | gold-haloed 🍱 with a hits-left bar over it reading `{n} TO K.O.`; jolts on every hit; splits like food on the K.O. |
| Over | `YOUR SCORE` · score · `Saving your score…` → `#3 of 27` or `#1 of 27. Top of the board! 🏆` · `12 sliced · 2 bombs · star caught  ·  Top score: 312` · `PLAY AGAIN` · `Check the leaderboard on the big screen.` |
| Over errors | `Couldn't save that one. Play again?` · `Couldn't reach the booth. Your score wasn't saved.` · `Lost the booth connection. Your score wasn't saved.` |
| Lost | `切` · `Connection dropped. This round won't count.` or `You left the page, so this round was cancelled.` · `TRY AGAIN` |
| Landscape | `📱` `Turn your phone upright to play.` |

Feedback per hit: sliced halves fly apart along the cut, juice particles in the food's colours, a popup. Bomb: red flash (0.3 s) and screen shake (0.28 s). Star: gold flash, the trail turns into a gold saber for the frenzy. Last 3 s: pulsing red border.

## Laptop (`/`)
Three columns: brand + QR (left), the stage (centre, the phone's world at the laptop's scale), leaderboard (right). Tokyo skyline and Tokyo Tower across the bottom; 忍 猫 斬 刀 drift up at 5% opacity.
| State | Verbatim strings |
|---|---|
| Gate (first load) | `斬` · `CLICK TO OPEN THE BOOTH` · `Turns on sound and music, and goes full screen.` |
| Left column | `斬` `KIRU` · `— JOHNSON JAPAN CLUB —` · QR · `SCAN TO PLAY` / `21 seconds. Your phone is the sword.` · play URL · `Works on any network, cellular too` (tunnel) or `Phones: join the same Wi-Fi as this laptop` (LAN, gold) · legend `+10 slice it` `−30 don't` `×2 frenzy` |
| Idle | a ghost demo round at 60% opacity · `DEMO` · `NEXT UP: YOU` · `Scan the code · slice the food · dodge the bombs` |
| Countdown | `{name} is up!` · `3` `2` `1` `斬!` with beeps |
| Live | `NOW SLICING {name}` · score · `⭐ ×2 FRENZY` · seconds left · the same phase banners (`Food only`, `Bombs incoming`, `Almost half are bombs`, `No new bombs. Food doubles.`) |
| Result (6.5 s) | `{name}` · score · `#3 on the board` · `🏆 NEW TOP SCORE` when #1 |
| Cancelled (2.5 s) | `{name}'s round was cancelled` |
| Leaderboard | `🏆 LEADERBOARD` · `{n} rounds played` · top 10, 👑 on #1, new entry flashes · empty: `Nobody yet. Be the first on the board.` |
| Corners | `● live` / `server not reachable, retrying…` · `M music · F fullscreen` |

Sound: chiptune BGM (square lead + triangle bass, C-major pentatonic) that speeds up per phase (0.22 → 0.19 → 0.15 s/step) and jumps an octave to 0.12 s/step in frenzy; a quiet triangle arpeggio when idle. Effects: slice (sawtooth sweep + noise), bomb (falling square + low noise boom), star (arpeggio), countdown beeps, chaos alarm, last-3-seconds ticks, end gong and a fanfare for a new top score.
