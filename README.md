# Arena Blitz

A Smash TV-style twin-stick arena shooter for phones (it also works on desktop).

**▶ Play now: https://socman1984-hub.github.io/ArenaBlitz/**
Open the link on your phone, turn it sideways, and use "Add to Home Screen" to install it like an app.

## How to play
- **Left thumb** (anywhere on the left half): move
- **Right thumb** (anywhere on the right half): aim. The gun fires on its own all the time.
- **Power attacks** (the buttons at the bottom): you get a fresh set every round.
  - **BLAST** (1 per round): a shockwave that wipes out everything near you and erases enemy bullets
  - **MISSILES** (2 per round): 14 homing missiles
  - **BLADES** (1 per round): spinning saws orbit you for 8 seconds
- Enemies pour in through the four doors. Clear them all to finish the round. Every 5th round has a boss.
- Pickups: ♥ extra life, **R** rapid fire, **S** spread gun, ⚡ an extra power charge, **◆** 10 credits.
- Kill quickly to build a combo multiplier (up to x5).

## Upgrades
You earn **◆ credits** as you play:
- Every kill: brute/bug 1, drone/slime 2, juggernaut 4, boss 40. The boss's summoned minions give none.
- Clearing a round: 8 + 2 × the round number.
- Flawless round (you took no hits): +10 more.
- ◆ pickups: +10.

The **Upgrade Shop** opens after every 2 rounds. Prices go up with each level you buy:

| Upgrade | Effect per level | Max |
|---|---|---|
| Firepower | +25% bullet damage | 5 |
| Trigger Finger | +15% fire rate | 5 |
| Multi-Shot | +1 bullet per shot | 3 |
| Piercing | bullets pass through +1 enemy | 3 |
| Speed Boots | +10% move speed | 4 |
| Armor | +1 max heart | 4 |
| Extra Blast | +1 BLAST each round | 2 |
| Missile Pods | +6 missiles per volley | 3 |
| Blade Master | +1 blade and +2s spin time | 3 |
| Magnet | pulls pickups to you, +50% drop rate | 2 |
| Med Kit | refill all hearts (can be bought again) | — |

Upgrades last for the whole run and reset when you start a new game.

## Enemies
- **Brute**: masked thug with a spiked club who charges straight at you
- **Skitter**: a fast six-legged bug
- **Eye Drone**: hovers at range and shoots; its eye turns red right before it fires
- **Slime**: splits into two Skitters when it dies
- **Juggernaut**: an armored tank with a turret that tracks you; takes a lot of hits
- **Overlord** (boss, every 5th round): spiked war machine with twin cannons, bullet rings, and minions. Below half health it gets faster and angrier.

Desktop controls: WASD to move, mouse or arrow keys to aim, 1/2/3 (or Q/E/R) for powers, P to pause, M to mute.

## Running it
From this folder:

```bash
python -m http.server 8080 --bind 0.0.0.0
```

- On this PC, open http://localhost:8080
- On your phone (same Wi-Fi), open http://<this PC's IP>:8080 and turn the phone sideways.

## Putting it on your phone like a real app
1. Host the folder on any free static host with HTTPS, such as GitHub Pages, Netlify, or Cloudflare Pages.
2. Open the link on your phone, then choose **Add to Home Screen** (Safari share menu, or Chrome's ⋮ menu).
   It launches full screen, in landscape, and works offline.
3. For the App Store or Google Play, wrap the same files with [Capacitor](https://capacitorjs.com/).

## Files
- `game.js`: all the game code (enemies, weapons, powers, rounds, drawing, touch controls, sound)
- `index.html`: the page that hosts the game canvas
- `manifest.json`, `sw.js`, `icon.svg`: let the game install to your home screen and run offline
