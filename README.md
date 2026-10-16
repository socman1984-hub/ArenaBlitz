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
- Pickups (rarer now; mostly ◆ so you can choose what to buy): ♥ extra life, **R** rapid fire, **S** spread gun, **L** laser, ⚡ an extra power charge, **◆** 10 credits.
- Kill quickly to build a combo multiplier (up to x5).
- If your thumb covers your guy, a zoomed-in bubble of him pops up just above so you can still see him.

## Rounds change as you go
- **Acts:** every 5 rounds ends in a boss, then the arena changes look: Neon Studio, Toxic Dome, Frost Rink, Inferno.
- **Pillars:** from round 2, each round has a different pillar layout. Pillars block bullets (yours and theirs), so use them as cover.
- **New enemies** are announced the first time they show up.
- **Twists:** from round 3, most rounds get a special rule, shown when the round starts:

| Twist | What happens |
|---|---|
| Swarm | A flood of fast bugs |
| Ambush | Enemies warp in anywhere on the floor; a red ring warns you first |
| Cash Rush | Double ◆ from kills, and extra ◆ drops |
| Minefield | Mines explode when you, an enemy, or your bullets touch them; you get a moment to run |
| Sniper Nest | Mostly eye drones; hide behind pillars |
| Overdrive | Enemies are faster, but you get rapid fire all round |
| Lights Out | Only the area around you is lit; enemy eyes and bullets still glow |
| Heavy Metal | Fewer enemies, all big ones |

## Upgrades
You earn **◆ credits** as you play:
- Every kill: brute/bug 1, drone/slime 2, juggernaut 4, boss 40. The boss's summoned minions give none.
- Clearing a round: 8 + 2 × the round number.
- Flawless round (you took no hits): +10 more.
- ◆ pickups: +10.

The **Upgrade Shop** opens after every 2 rounds. It has two tabs.

**UPGRADES** last for the whole run. Prices go up with each level you buy:

| Upgrade | Effect per level | Max |
|---|---|---|
| Firepower | +25% bullet damage | 8 |
| Trigger Finger | +15% fire rate | 6 |
| Multi-Shot | +1 bullet per shot | 3 |
| Piercing | bullets pass through +1 enemy | 3 |
| Speed Boots | +10% move speed | 4 |
| Armor | +1 max heart | 6 |
| Extra Blast | +1 BLAST each round | 2 |
| Missile Pods | +6 missiles per volley | 3 |
| Blade Master | +1 blade and +2s spin time | 3 |
| Magnet | pulls pickups to you, +50% drop rate | 2 |
| Lucky Shot | +8% chance a bullet does triple damage | 5 |
| Field Medic | heal 1 heart at the start of every round | 2 |
| Power Surge | gun pickups last +4s | 3 |
| Overcharge | +10% damage | no limit |

**GEAR** works like a pickup you choose: it switches on when the next round's fight starts and lasts 10 seconds (+4s per Power Surge level). The price goes up with the round number:

| Gear | Effect |
|---|---|
| Spread Gun / Rapid Fire / Laser | that gun for the timer (one gun per shop visit) |
| Force Field | blocks up to 2 hits while it lasts |
| Buddy Drone | a helper that circles you and shoots the nearest enemy |
| Gem Doubler | double ◆ from kills while it lasts |
| Power Pack | +1 of every power for the next round |
| Med Kit | refill all hearts right away |

Upgrades and gear reset when you start a new game.

## Enemies
- **Brute**: masked thug with a spiked club who charges straight at you
- **Skitter**: a fast six-legged bug
- **Eye Drone**: hovers at range and shoots; its eye turns red right before it fires
- **Slime**: splits into two Skitters when it dies
- **Juggernaut**: an armored tank with a turret that tracks you; takes a lot of hits

### Bosses
Every 5th round is a boss fight, and each arena look has its own boss. Below half health every boss gets faster and angrier.
- **The Overlord** (Neon Studio): spiked war machine with twin cannons, bullet rings, and minions.
- **Sludge Queen** (Toxic Dome): lobs acid at marked spots that leave burning puddles, sprays acid, and spawns slimes.
- **Cryo Sentinel** (Frost Rink): spins out ice shards, then aims (a red lane shows its path) and charges. After it crashes it's dazed and takes double damage.
- **Magma Titan** (Inferno): meteors land on marked spots, fire rings expand with a gap to slip through, and it summons fast minions.

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

## Versions and updates
- The game shows its version number and what's new each time it opens.
- It checks for a new version every minute and whenever you come back to it. If there is one, it reloads by itself on the title screen. If you're mid-game, it waits until game over and installs when you tap to continue, so you never lose a run.
- To release an update: add an entry at the top of `version.json` and change its `"version"` to match. The version number and release notes live only there.

## Files
- `game.js`: all the game code (enemies, weapons, powers, rounds, drawing, touch controls, sound)
- `index.html`: the page that hosts the game canvas
- `version.json`: the version number and release notes
- `manifest.json`, `sw.js`, `icon.svg`: let the game install to your home screen and run offline
